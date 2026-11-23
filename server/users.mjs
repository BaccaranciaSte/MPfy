// One person's data on this source: users/<profileId>.log (users/owner.log for
// the owner until a profile claims the source), an append-only log (userlog.mjs):
// playlists, likes, plays (recents) and playlist covers. Playlist, like and
// recent objects are served as before; foreign track ids accepted (they may live
// on another source). recents is the person's listening history from every
// device, newest first: the latest 1,000 plays are kept (older ones go without
// notice), /api/library serves the newest 50 and /api/recents pages through all of
// them. A change is checked, written as one line (or one batch of lines) and only
// then applied; a refused request or a failed write changes nothing. Playlist ids
// are unique across all the users of the source.
//
// Nobody is loaded at start: each person's log gives a summary (its version and
// epochs, its playlist ids, its playlist cover image ids), read from the end of its
// snapshot and the lines after it. A request opens the person it needs (`await
// users.open(key)`: the first open replays the log in slices, opens meanwhile wait
// for the same replay) and releases it when it ends; a person nobody held for 10
// minutes leaves memory and is a summary again. A track removed everywhere is one
// line appended to the log of each person not loaded, and a sweep in slices for
// each person loaded. A merge (the claim, set-owner --move-data) holds both people
// until it ends.
//
// A users/<key>.json of the format before (an older MPfy) is migrated to a log at
// start and never written again by a run: a log whose `from` is not that .json's
// stat is kept aside (`.replaced-<ms>`) and the .json migrated again.
// `export-compat` (the server stopped) writes every .json from the logs, for an
// older MPfy, and the logs then know those files.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { HttpError, apiError } from './errors.mjs'
import { isTrackId, isPlaylistId, isProfileId, COVER_SIZES } from './ids.mjs'
import { ensureDir, unlinkQuiet, renameSyncRetry, log, logError } from './util.mjs'
import { sameBytesSync } from './dbjson.mjs'
import { UserLog, Person, IDS, NODE_FS, ZERO_EPOCH, newEpochId, publicPlaylist, diskError } from './userlog.mjs'
import { nearestSlot, removalSlots, rebaseOrder } from './userops.mjs'

export { nearestSlot, removalSlots, rebaseOrder }

// The plays /api/library serves (the Home recents), and the plays kept.
export const MAX_RECENTS = 50
export const MAX_HISTORY = 1000
// GET /api/recents: plays per page.
export const RECENTS_PAGE = 100
export const MAX_RECENTS_PAGE = 200
const MAX_PLAYLIST_LENGTH = 20000
export const MAX_LIKES = 100000
export const MAX_PLAYLISTS = 10000
export const MAX_PLAYLIST_ENTRIES = 100000
// POST /api/likes: ids in one request, adds and removals together.
export const MAX_BULK_LIKES = 5000
// A .json of the format before bigger than this (no app makes one) is set aside, not parsed.
// It sits above the largest file the limits above allow (10,000 playlists with every name and
// description at its longest is about 76 MB). A log is never read whole.
const MAX_FILE_BYTES = 128 * 1024 * 1024
const CONTEXT_TYPES = new Set(['playlist', 'album', 'artist', 'liked', 'library', 'search'])
// POST /api/played: a client-supplied time is kept when it is this recent (offline plays).
const PLAYED_AT_MAX_AGE = 30 * 24 * 60 * 60 * 1000
// ... and not further in the future than this (clock skew between devices).
const PLAYED_AT_MAX_SKEW = 5 * 60 * 1000
const LIKES_SLICE = 5000
// A person nobody holds leaves memory after this long.
export const IDLE_MS = 10 * 60 * 1000
// The sweeper of a removed track works in slices of this long.
const SWEEP_SLICE_MS = 5
// export-compat writes a .json in pieces of about this size.
const EXPORT_SLICE_BYTES = 256 * 1024
const JSON_RE = /^(owner|[0-9a-f]{32})\.json$/
const LOG_RE = /^(owner|[0-9a-f]{32})\.log$/
const INTERNAL = 'Errore interno del server'
const EMPTY = Buffer.alloc(0)

const tick = () => new Promise((resolve) => setImmediate(resolve))

const REAL_CLOCK = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (timer) => clearTimeout(timer)
}

export function isUserKey (key) {
  return key === 'owner' || isProfileId(key)
}

// Ids of `bytes` bytes each (hex strings) packed in one Buffer, outside the heap.
function packIds (ids, bytes) {
  const list = [...ids]
  if (list.length === 0) return EMPTY
  const buf = Buffer.alloc(list.length * bytes)
  for (let i = 0; i < list.length; i++) buf.write(list[i], i * bytes, bytes, 'hex')
  return buf
}

function unpackIds (buf, bytes) {
  const out = []
  for (let at = 0; at + bytes <= buf.length; at += bytes) out.push(buf.toString('hex', at, at + bytes))
  return out
}

// Whether the packed ids hold this one (at a whole id's place, never across two).
function holdsId (buf, id, bytes) {
  if (buf.length === 0) return false
  const needle = Buffer.from(id, 'hex')
  if (needle.length !== bytes) return false
  for (let at = buf.indexOf(needle); at !== -1; at = buf.indexOf(needle, at + 1)) {
    if (at % bytes === 0) return true
  }
  return false
}

// What the source keeps of one person: its log (its versions, its epochs, the epoch this run
// opened: all of it outlives the person's content) and either the person loaded or its
// summary.
class Slot {
  constructor (key, log) {
    this.key = key
    this.log = log
    this.user = null // the person, while loaded
    this.opening = null // { st, sync, promise } while its log is replayed
    this.refs = 0
    this.idleSince = 0
    this.timer = null
    this.pinned = false // its migration could not be written: it stays in memory this run
    // The summary, while not loaded: playlist ids (8 bytes each), playlist cover image ids
    // (12 bytes each, a superset), the horizon and the counts of its last snapshot.
    this.pl = EMPTY
    this.pc = EMPTY
    this.horizon = 0
    this.n = [0, 0, 0]
    this.jobs = [] // removals waiting for the sweeper: { ids, at }
    this.sweep = null // the removal under way (a generator, one step per playlist)
    this.sweeping = false
    this.idleWaiters = []
  }
}

export class Users {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir
   * @param {number} [opts.debounceMs]  kept for callers; changes are written at once
   * @param {(coverId: string) => void} [opts.releaseCover]  a cover nobody may use any more
   * @param {number} [opts.maxFileBytes]  the biggest .json of the format before that is read
   * @param {object} [opts.fsx]  file system calls of the logs (checks)
   * @param {object} [opts.logLimits]  sizes of the logs' compactions (checks)
   * @param {object} [opts.caps]  likes and playlist entries per person (checks of the cost at any size)
   * @param {number} [opts.idleMs]  how long a person nobody holds stays in memory
   * @param {object} [opts.clock]  { now, setTimeout, clearTimeout } of that wait (checks)
   */
  constructor ({ dataDir, debounceMs = 500, releaseCover = () => {}, maxFileBytes = MAX_FILE_BYTES, fsx = NODE_FS, logLimits = {}, caps = {}, idleMs = IDLE_MS, clock = null }) {
    this.dir = path.join(path.resolve(dataDir), 'users')
    this.debounceMs = debounceMs
    this.releaseCover = releaseCover
    this.maxFileBytes = maxFileBytes
    this.fsx = fsx
    this.logLimits = logLimits
    this.maxLikes = caps.likes ?? MAX_LIKES
    this.maxEntries = caps.entries ?? MAX_PLAYLIST_ENTRIES
    this.idleMs = idleMs
    this.clock = clock || REAL_CLOCK
    // Called at the steps of a merge (checks): { merged(info), mergeStep(name) }; merged may
    // return a promise the merge waits for.
    this.hooks = null
    this.opens = 0 // replays begun (checks)
    this._slots = new Map() // key -> Slot
    this._locks = new Map() // key -> a promise of the merge holding the person
    this._merging = Promise.resolve(true)
    this._closed = false
  }

  _log (key) {
    return new UserLog({ file: this.fileOf(key), key, fsx: this.fsx, limits: this.logLimits })
  }

  _slot (key) {
    let slot = this._slots.get(key)
    if (slot === undefined) {
      if (!isUserKey(key)) throw new Error('invalid user key')
      slot = new Slot(key, this._log(key))
      this._slots.set(key, slot)
    }
    return slot
  }

  /** Every person with a log or a .json: its summary, nobody loaded (a .json alone is migrated first). */
  load () {
    ensureDir(this.dir)
    const keys = new Set()
    for (const name of fs.readdirSync(this.dir)) {
      if (name.endsWith('.tmp')) {
        // A whole write, a compaction or an export cut by a crash: the file it was for is whole.
        unlinkQuiet(path.join(this.dir, name))
        continue
      }
      const m = JSON_RE.exec(name) || LOG_RE.exec(name)
      if (m !== null) keys.add(m[1])
    }
    for (const key of keys) {
      try {
        this._loadKey(key)
      } catch (err) {
        logError('users/' + key + ': not read (' + err.message + ')')
      }
    }
  }

  // The log is the truth when it knows the .json there (the stat it was migrated from, or the
  // last export's), or there is no .json; a .json alone is migrated; a .json an older MPfy
  // wrote since sends the log aside, then is migrated.
  _loadKey (key) {
    const slot = new Slot(key, this._log(key))
    const jsonFile = this.jsonOf(key)
    let st = null
    try {
      st = fs.statSync(jsonFile)
    } catch {}
    const s = slot.log.scan()
    if (s.status === 'ok') {
      const from = slot.log.from
      if (st === null || (from !== null && from.size === st.size && from.mtimeMs === st.mtimeMs) || this._sameJson(slot, jsonFile, st)) {
        slot.pl = packIds(s.playlists, 8)
        slot.pc = packIds(s.covers, 12)
        slot.horizon = s.horizon
        slot.n = s.n
        this._slots.set(key, slot)
        return
      }
      const aside = slot.log.setAside('replaced')
      if (aside === null) {
        // Never written over: the log stays the truth this run, the .json is read at the next start.
        logError(path.basename(slot.log.file) + ': ' + path.basename(jsonFile) + ' was written by an older MPfy since, but the log could not be set aside')
        slot.pl = packIds(s.playlists, 8)
        slot.pc = packIds(s.covers, 12)
        this._slots.set(key, slot)
        return
      }
      logError(path.basename(slot.log.file) + ': ' + path.basename(jsonFile) + ' was written by an older MPfy since, the log kept as ' + path.basename(aside) + ' and the .json migrated again')
    }
    if (st === null) return
    if (this._tooBig(jsonFile, st.size)) return
    let data = null
    let hash
    try {
      const raw = fs.readFileSync(jsonFile)
      hash = crypto.createHash('sha256').update(raw).digest('hex')
      data = JSON.parse(raw.toString('utf8'))
    } catch {}
    this._migrate(key, data, { size: st.size, mtimeMs: st.mtimeMs, hash })
  }

  // The .json's time changed since the log knew it, but not its bytes (a copy that did not
  // keep the times): the same file, the log stays the truth and knows its new stat.
  _sameJson (slot, jsonFile, st) {
    const from = slot.log.from
    try {
      if (!sameBytesSync(jsonFile, from, st.size)) return false
    } catch {
      return false
    }
    try {
      slot.log.noteExport({ size: st.size, mtimeMs: st.mtimeMs, hash: from.hash })
    } catch {}
    log(path.basename(jsonFile) + ' has the bytes ' + path.basename(slot.log.file) + ' knows, only its time changed: the log stays the truth')
    return true
  }

  // A person's data in the format before, written as a new log, then out of memory. One the
  // disk refused stays in memory this run (its .json is still the truth on disk; the log is
  // written at its first change).
  _migrate (key, data, from) {
    const slot = new Slot(key, this._log(key))
    this._slots.set(key, slot)
    const user = new UserData(this, key, slot.log, new Person())
    if (user._migrateFrom(data, from)) this._unload(slot, user)
    else {
      slot.user = user
      slot.pinned = true
    }
  }

  /**
   * Data in the format of a .json before logs (the owner's from an old db.json): migrated into
   * the person's log, when the person has none. True when it was.
   */
  migrateLegacy (key, data) {
    if (data === null || data === undefined || !isUserKey(key)) return false
    const slot = this._slots.get(key)
    if (slot !== undefined && (slot.log.exists || slot.user !== null)) return false
    this._migrate(key, data, null)
    return true
  }

  // Parsing it could take the whole heap, at every start: moved aside instead.
  _tooBig (file, size) {
    if (size <= this.maxFileBytes) return false
    const aside = file + '.toobig-' + Date.now()
    try {
      renameSyncRetry(file, aside)
    } catch {}
    logError(path.basename(file) + ' is ' + size + ' bytes, moved to ' + path.basename(aside) + ' instead of reading it')
    return true
  }

  /** The person's log. */
  fileOf (key) {
    if (!isUserKey(key)) throw new Error('invalid user key')
    return path.join(this.dir, key + '.log')
  }

  /** The person's .json of the format before (read to migrate, written only by export-compat). */
  jsonOf (key) {
    if (!isUserKey(key)) throw new Error('invalid user key')
    return path.join(this.dir, key + '.json')
  }

  /** Whether the person has data here (a log, or held in memory). */
  has (key) {
    return this._slots.has(key)
  }

  /** Whether the person is in memory now. */
  loaded (key) {
    const slot = this._slots.get(key)
    return slot !== undefined && slot.user !== null
  }

  keys () {
    return [...this._slots.keys()]
  }

  // ------------------------------------------------------------- open and hold

  /**
   * The person, loaded now when it is not (its log replayed at once): for tools and checks.
   * Requests use open(), which holds the person while they use it.
   */
  get (key) {
    const slot = this._slot(key)
    if (slot.user !== null) return slot.user
    const o = slot.opening || this._begin(slot)
    o.sync = true
    if (o.st !== null) {
      try {
        o.st.finish()
      } catch (err) {
        if (slot.opening === o) slot.opening = null
        throw err
      }
    }
    return this._opened(slot, o)
  }

  /**
   * The person, held while a request uses it: { user, release }. The first open replays its
   * log in slices; opens meanwhile wait for the same replay; a merge holding the person is
   * waited for first. release() lets it go (once is enough, more do nothing); a person nobody
   * holds leaves memory IDLE_MS later.
   */
  async open (key) {
    if (!isUserKey(key)) throw new Error('invalid user key')
    for (;;) {
      await this.unlocked(key)
      if (this._closed) throw new HttpError(500, INTERNAL)
      const slot = this._slot(key)
      slot.refs++
      let user
      try {
        user = slot.user !== null ? slot.user : await (slot.opening || this._begin(slot)).promise
      } catch (err) {
        this._release(slot)
        throw err
      }
      if (this._slots.get(key) === slot && slot.user === user) {
        let held = true
        return {
          user,
          release: () => {
            if (!held) return
            held = false
            this._release(slot)
          }
        }
      }
      // The person went meanwhile (merged into another, removed): what is there now.
      this._release(slot)
    }
  }

  /** Resolves when no merge holds the person. */
  async unlocked (key) {
    for (let lock = this._locks.get(key); lock !== undefined; lock = this._locks.get(key)) await lock
  }

  // The replay of a person's log begins; its promise ends with the person loaded.
  _begin (slot) {
    this.opens++
    const o = { st: slot.log.exists ? slot.log.opener() : null, sync: false, promise: null }
    slot.opening = o
    o.promise = (async () => {
      try {
        if (o.st !== null) {
          while (!o.st.done) {
            await tick()
            if (slot.opening !== o) {
              // Ended at once meanwhile (get), or given up.
              if (slot.user === null) throw new HttpError(500, INTERNAL)
              return slot.user
            }
            if (this._closed) {
              o.st.stop()
              throw new HttpError(500, INTERNAL)
            }
            o.st.step()
          }
        }
        return this._opened(slot, o)
      } catch (err) {
        if (slot.opening === o) slot.opening = null
        throw err
      }
    })()
    o.promise.catch(() => {})
    return o
  }

  // The replay ended: the person is in memory (empty when its log was missing or set aside).
  _opened (slot, o) {
    if (slot.opening !== o) return slot.user
    slot.opening = null
    // A replay cut short by a read error leaves the person as it is on disk, never empty.
    if (o.st !== null && (o.st.status === 'failed' || o.st.status === 'stopped')) throw new HttpError(500, INTERNAL)
    const log = slot.log
    const orphan = this._slots.get(slot.key) !== slot || this._closed
    if (o.st !== null && o.st.status === 'ok' && !orphan) log._opened('ok', { compactOnOpen: !o.sync })
    else if (o.st !== null && o.st.status !== 'ok') {
      // Nothing to read any more: a new person, its log made at its first change.
      log.exists = false
      log.person = null
      log.version = 0
      log.epochs = []
      log.runEpoch = null
    }
    if (log.person === null) log.person = new Person()
    const user = new UserData(this, slot.key, log)
    if (orphan) {
      user._discarded = true
      return user
    }
    slot.user = user
    slot.pl = EMPTY
    slot.pc = EMPTY
    if (slot.jobs.length > 0) this._sweepRun(slot)
    if (slot.refs === 0) this._idleFrom(slot)
    return user
  }

  _release (slot) {
    slot.refs--
    if (slot.refs === 0 && this._slots.get(slot.key) === slot) this._idleFrom(slot)
  }

  _idleFrom (slot) {
    slot.idleSince = this.clock.now()
    this._arm(slot, this.idleMs)
  }

  _arm (slot, ms) {
    if (slot.timer !== null || this._closed) return
    const timer = this.clock.setTimeout(() => {
      if (slot.timer === timer) slot.timer = null
      this._idle(slot)
    }, ms)
    slot.timer = timer
    if (timer && typeof timer.unref === 'function') timer.unref()
  }

  // The idle timer: the person leaves memory once nobody held it for the whole wait; never
  // while it is held, compacted, swept or part of a merge.
  _idle (slot) {
    if (this._closed || this._slots.get(slot.key) !== slot || slot.user === null) return
    if (slot.refs > 0) return // armed again when its last holder lets it go
    const left = slot.idleSince + this.idleMs - this.clock.now()
    if (left > 0) return this._arm(slot, left)
    if (slot.pinned || slot.log.compaction !== null || this._locks.has(slot.key) || this._sweepBusy(slot)) return this._arm(slot, this.idleMs)
    this._unload(slot, slot.user)
  }

  // The person out of memory: its summary made from it; what its log knows of its versions
  // stays. A person with no log leaves nothing behind.
  _unload (slot, user) {
    const p = user.p
    slot.pl = packIds(p.playlists.keys(), 8)
    slot.pc = packIds(p.coverIds(), 12)
    slot.horizon = p.horizon
    slot.n = [p.likes.live, p.table.n, p.entries]
    user._dropped = true
    user._frozen = p
    if (slot.user === user) slot.user = null
    if (slot.timer !== null) {
      this.clock.clearTimeout(slot.timer)
      slot.timer = null
    }
    slot.log.unload()
    if (!slot.log.exists && slot.refs === 0 && slot.opening === null && this._slots.get(slot.key) === slot) this._slots.delete(slot.key)
  }

  // ------------------------------------------------------------- the summaries

  /**
   * What a reader needs of a person without its content, without loading it; null when it
   * has no log.
   */
  summary (key) {
    const slot = this._slots.get(key)
    if (slot === undefined || !slot.log.exists) return null
    const log = slot.log
    const loaded = slot.user !== null
    const p = loaded ? slot.user.p : null
    return {
      key,
      version: log.version,
      epoch: log.epoch,
      epochs: log.epochs.map((e) => [e.id, e.first, e.last]),
      horizon: loaded ? p.horizon : slot.horizon,
      playlists: loaded ? [...p.playlists.keys()] : unpackIds(slot.pl, 8),
      covers: loaded ? p.coverIds() : unpackIds(slot.pc, 12),
      counts: loaded ? [p.likes.live, p.table.n, p.entries] : slot.n.slice(),
      bytes: { size: log.size, snapshot: log.snapBytes, tail: log.tailBytes },
      from: log.from,
      loaded
    }
  }

  /**
   * The person's version and its epoch (0 and the zero epoch while it has no log), loaded or
   * not; null while its log is being replayed.
   */
  head (key) {
    const slot = this._slots.get(key)
    if (slot === undefined) return { version: 0, epoch: ZERO_EPOCH }
    if (slot.opening !== null) return null
    if (slot.user !== null) return { version: slot.user.version, epoch: slot.user.epoch }
    if (!slot.log.exists) return { version: 0, epoch: ZERO_EPOCH }
    return { version: slot.log.version, epoch: slot.log.epoch }
  }

  hasPlaylist (key, playlistId) {
    const slot = this._slots.get(key)
    if (slot === undefined || typeof playlistId !== 'string' || !isPlaylistId(playlistId)) return false
    if (slot.user !== null) return slot.user.playlists.has(playlistId)
    return holdsId(slot.pl, playlistId, 8)
  }

  playlistIdTaken (id) {
    for (const slot of this._slots.values()) {
      if (slot.user !== null ? slot.user.playlists.has(id) : holdsId(slot.pl, id, 8)) return true
    }
    return false
  }

  playlistCoverIds () {
    const ids = new Set()
    for (const slot of this._slots.values()) {
      for (const id of slot.user !== null ? slot.user.p.coverIds() : unpackIds(slot.pc, 12)) ids.add(id)
    }
    return ids
  }

  /**
   * Playlist covers whose image is gone (deleted by hand) forgotten (the check at start): a
   * person not loaded gets the lines in its log and stays not loaded.
   */
  dropMissingCovers (exists) {
    for (const slot of [...this._slots.values()]) {
      try {
        if (slot.user !== null) {
          slot.user.dropMissingCovers(exists)
          continue
        }
        if (!slot.log.exists || unpackIds(slot.pc, 12).every((id) => exists(id))) continue
        const entries = slot.log.coverEntries()
        const ops = []
        for (const [id, e] of entries) {
          const sizes = COVER_SIZES.filter((size) => e[size] !== null && !exists(e[size]))
          if (sizes.length === 0) continue
          ops.push({ o: 'cc', id, sizes })
          for (const size of sizes) e[size] = null
        }
        if (ops.length > 0) slot.log.appendLines(ops)
        const ids = []
        for (const e of entries.values()) {
          if (e.small !== null) ids.push(e.small)
          if (e.large !== null) ids.push(e.large)
        }
        slot.pc = packIds(ids, 12)
      } catch (err) {
        logError('playlist covers of ' + slot.key + ' not checked: ' + err.message)
      }
    }
  }

  // ------------------------------------------------------------- removals

  /**
   * Track files gone: their ids leave every person's playlists, likes and plays. A person
   * loaded (or being opened) sweeps them in slices: at once while one slice's time lasts
   * (shared by everyone loaded, so the request holds the loop for one slice however many
   * people are loaded), the others from the next turn; a person not loaded gets one line in
   * its log, applied at its next open. Nobody is opened for it.
   */
  removeTrackEverywhere (ids) {
    const list = [...new Set((Array.isArray(ids) ? ids : [ids]).filter(isTrackId))]
    if (list.length === 0 || this._closed) return
    const at = Date.now()
    const until = performance.now() + SWEEP_SLICE_MS
    for (const slot of [...this._slots.values()]) {
      if (slot.user !== null || slot.opening !== null) {
        slot.jobs.push({ ids: list, at })
        if (slot.user === null) continue
        if (performance.now() < until) this._sweepRun(slot)
        else setImmediate(() => this._sweepRun(slot))
      } else if (slot.log.exists) {
        try {
          slot.log.appendRemoval(list, at)
        } catch (err) {
          logError('tracks not removed from the data of ' + slot.key + ': ' + err.message)
        }
      }
    }
  }

  _sweepBusy (slot) {
    return slot.sweep !== null || slot.jobs.length > 0
  }

  // Resolves when the person's removals are swept.
  _sweepIdle (slot) {
    return this._sweepBusy(slot) ? new Promise((resolve) => slot.idleWaiters.push(resolve)) : Promise.resolve()
  }

  // The sweeper of a loaded person: one removal after the other, a few milliseconds at a time.
  _sweepRun (slot) {
    if (slot.sweeping) return
    slot.sweeping = true
    const t0 = performance.now()
    try {
      while (slot.user !== null && !this._closed) {
        if (slot.sweep === null) {
          if (slot.jobs.length === 0) break
          slot.sweep = slot.user._sweep(slot.jobs.shift())
        }
        let r
        try {
          r = slot.sweep.next()
        } catch (err) {
          logError('tracks not removed from the data of ' + slot.key + ': ' + err.message)
          r = { done: true }
        }
        if (r.done) slot.sweep = null
        if (performance.now() - t0 >= SWEEP_SLICE_MS) break
      }
    } finally {
      slot.sweeping = false
    }
    if (slot.user !== null && !this._closed && this._sweepBusy(slot)) {
      setImmediate(() => this._sweepRun(slot))
      return
    }
    if (slot.user === null && slot.opening === null) slot.jobs = []
    if (!this._sweepBusy(slot) || slot.user === null) {
      const waiters = slot.idleWaiters
      slot.idleWaiters = []
      for (const resolve of waiters) resolve()
    }
  }

  // Every removal of a loaded person swept now (a stop: none is lost).
  _sweepAll (slot) {
    for (;;) {
      if (slot.sweep === null) {
        if (slot.jobs.length === 0) return
        slot.sweep = slot.user._sweep(slot.jobs.shift())
      }
      try {
        while (!slot.sweep.next().done);
      } catch (err) {
        logError('tracks not removed from the data of ' + slot.key + ': ' + err.message)
      }
      slot.sweep = null
    }
  }

  // ------------------------------------------------------------- merges

  /**
   * Merge A into B (the claim, set-owner --move-data): A's playlists that B lacks appended
   * (ids kept), likes united (the newest time wins), plays united by time and cut at 1,000,
   * playlist covers united. One change of B: the reset line, whose version is on everything of
   * B (its devices take one whole user part); then B's log compacted; then A's log deleted.
   * Both people are held from the call until then: an open of either waits for it. Merges run
   * one after the other. A stop or a crash before A's log goes leaves A to merge again at the
   * next start, which changes nothing but writes a new reset. Resolves true when done (or
   * nothing to do), false when it is left for the next start.
   */
  merge (fromKey, toKey) {
    if (fromKey === toKey) return Promise.resolve(true)
    if (!isUserKey(fromKey) || !isUserKey(toKey)) throw new Error('invalid user key')
    const run = this._merging.then(() => this._merge(fromKey, toKey)).catch((err) => {
      logError('the data of ' + fromKey + ' not merged into ' + toKey + ' (again at the next start): ' + err.message)
      return false
    })
    this._merging = run
    const lock = run.then(() => {})
    for (const key of [fromKey, toKey]) {
      this._locks.set(key, lock)
      lock.then(() => {
        if (this._locks.get(key) === lock) this._locks.delete(key)
      })
    }
    return run
  }

  async _hook (name, info) {
    if (this.hooks !== null && typeof this.hooks[name] === 'function') await this.hooks[name](info)
  }

  async _merge (fromKey, toKey) {
    if (this._closed) return false
    const fromSlot = this._slots.get(fromKey)
    if (fromSlot === undefined) return true
    if (!fromSlot.log.exists && !fromSlot.pinned && fromSlot.opening === null) {
      // Nothing of A on disk, so nothing in memory either (any change writes the log).
      if (fromSlot.user !== null) fromSlot.user._discarded = true
      if (fromSlot.timer !== null) {
        this.clock.clearTimeout(fromSlot.timer)
        fromSlot.timer = null
      }
      this._slots.delete(fromKey)
      return true
    }
    const toSlot = this._slot(toKey)
    fromSlot.refs++
    toSlot.refs++
    try {
      const from = fromSlot.user !== null ? fromSlot.user : await (fromSlot.opening || this._begin(fromSlot)).promise
      const to = toSlot.user !== null ? toSlot.user : await (toSlot.opening || this._begin(toSlot)).promise
      // A's ids interned in B's table ahead, a slice at a time (no index of B moves, so nothing
      // of B changes): the merge itself then only reads them.
      const map = await to.p.internAhead(from.p.table, { sliceMs: SWEEP_SLICE_MS, live: () => !this._closed && fromSlot.user === from && toSlot.user === to })
      if (map === null) return false
      // Nothing of either under way at the merge: their removals swept, B's compaction over.
      for (;;) {
        if (this._closed) return false
        if (this._sweepBusy(fromSlot)) await this._sweepIdle(fromSlot)
        else if (this._sweepBusy(toSlot)) await this._sweepIdle(toSlot)
        else if (to.log.compaction !== null) await to.log.settled()
        else break
      }
      if (fromSlot.user !== from || toSlot.user !== to || from._discarded || to._discarded) return false
      const probe = this.hooks !== null && typeof this.hooks.mergeStep === 'function' ? this.hooks.mergeStep : null
      const v = to.mergeFrom(from, probe, map)
      if (v === null) return false
      // A's holders may read on; none changes it again (it would be lost with its log).
      from._discarded = true
      // B's log written again from the merged state: a compaction begun after the change.
      const log = to.log
      const before = log.compactions
      const compacted = log.compaction !== null ? log.settled() : log.compact()
      await this._hook('merged', { from: fromKey, to: toKey, version: v })
      await compacted
      if (log.compactions === before || this._closed) {
        // B's log may not hold A's data yet: A stays, merged again at the next start, and is
        // read again from its own log meanwhile.
        if (!this._closed) {
          logError(path.basename(log.file) + ': not compacted after the merge of ' + fromKey + ', merged again at the next start')
          this._unload(fromSlot, from)
        }
        return false
      }
      // A's data lives in B now: A's log and .json go, and A is nobody here.
      from._dropped = true
      if (fromSlot.timer !== null) {
        this.clock.clearTimeout(fromSlot.timer)
        fromSlot.timer = null
      }
      fromSlot.user = null
      fromSlot.log.remove()
      unlinkQuiet(this.jsonOf(fromKey))
      if (this._slots.get(fromKey) === fromSlot) this._slots.delete(fromKey)
      return true
    } finally {
      this._release(fromSlot)
      this._release(toSlot)
    }
  }

  // ------------------------------------------------------------- the rest

  /** Delete a person's data (profile removed): its playlist covers may go. */
  remove (key) {
    const slot = this._slots.get(key)
    let covers = []
    if (slot !== undefined) {
      if (slot.user !== null) {
        covers = slot.user.p.coverIds()
        slot.user._discarded = true
        slot.user = null
      } else covers = unpackIds(slot.pc, 12)
      if (slot.timer !== null) {
        this.clock.clearTimeout(slot.timer)
        slot.timer = null
      }
      if (slot.opening !== null && slot.opening.st !== null) slot.opening.st.stop()
      slot.jobs = []
      slot.sweep = null
      slot.log.close()
      this._slots.delete(key)
      for (const resolve of slot.idleWaiters.splice(0)) resolve()
    }
    unlinkQuiet(this.fileOf(key))
    unlinkQuiet(this.jsonOf(key))
    for (const id of new Set(covers)) this.releaseCover(id)
  }

  /**
   * export-compat (with the server stopped): every person's .json written from its log in the
   * format before, by a temporary file synced and renamed; each log then knows its .json (an
   * `xp` line), so the next start keeps the log as the truth while that .json is as written.
   * People are loaded one at a time. Resolves with the number of people written.
   */
  async exportCompat () {
    let n = 0
    for (const key of [...this._slots.keys()]) {
      const slot = this._slots.get(key)
      if (slot === undefined || !slot.log.exists) continue
      const { user, release } = await this.open(key)
      try {
        await user.exportJson()
        n++
        await slot.log.settled()
      } finally {
        release()
      }
      if (slot.refs === 0 && slot.user === user && !slot.pinned) this._unload(slot, user)
    }
    return n
  }

  /** Every log of a person in memory synced now. */
  flush () {
    for (const slot of this._slots.values()) if (slot.user !== null) slot.log.syncNow()
  }

  /** Resolves when no merge, replay, compaction or sweep is under way. */
  async settled () {
    for (;;) {
      await this._merging
      const waits = []
      for (const slot of this._slots.values()) {
        if (slot.opening !== null) waits.push(slot.opening.promise.catch(() => {}))
        if (slot.log.compaction !== null) waits.push(slot.log.settled())
        if (this._sweepBusy(slot) && slot.user !== null) waits.push(this._sweepIdle(slot))
      }
      if (waits.length === 0 && this._locks.size === 0) return
      await Promise.all(waits)
      await tick()
    }
  }

  /** The stop: removals still waiting swept, every log synced and closed. */
  close () {
    if (this._closed) return
    this._closed = true
    for (const slot of this._slots.values()) {
      if (slot.timer !== null) {
        this.clock.clearTimeout(slot.timer)
        slot.timer = null
      }
      if (slot.user !== null && !slot.user._discarded && !slot.user._dropped) this._sweepAll(slot)
      else if (slot.opening !== null && slot.jobs.length > 0) {
        // Being opened: its removals become lines of its log, applied at its next open.
        if (slot.opening.st !== null) slot.opening.st.stop()
        for (const job of slot.jobs) {
          try {
            slot.log.appendRemoval(job.ids, job.at)
          } catch (err) {
            logError('tracks not removed from the data of ' + slot.key + ': ' + err.message)
          }
        }
      }
      slot.jobs = []
      slot.sweep = null
      for (const resolve of slot.idleWaiters.splice(0)) resolve()
      slot.log.close()
    }
  }
}

// Ids of a request resolved to id indexes without adding new ones to the table: an id the
// table lacks gets a negative number of its own until the change is written.
class Resolver {
  constructor (table) {
    this.table = table
    this.temp = new Map()
    this.hexes = []
  }

  idx (hex) {
    const i = this.table.find(hex)
    if (i >= 0) return i
    let t = this.temp.get(hex)
    if (t === undefined) {
      this.hexes.push(hex)
      t = -this.hexes.length
      this.temp.set(hex, t)
    }
    return t
  }

  hex (i) {
    return i >= 0 ? this.table.hex(i) : this.hexes[-i - 1]
  }

  /** The list with every id in the table (once its change is written). */
  real (list) {
    return list.map((i) => (i >= 0 ? i : this.table.intern(this.hexes[-i - 1])))
  }
}

/** The likes as an answer serializes them (newest first, { id, at }), made only when serialized. */
class LikesView {
  constructor (user) {
    this._user = user
  }

  toJSON () {
    return this._user.p.likesList()
  }

  get length () {
    return this._user.p.likes.live
  }

  [Symbol.iterator] () {
    return this.toJSON()[Symbol.iterator]()
  }

  map (fn) {
    return this.toJSON().map(fn)
  }
}

function drained (out, signal) {
  return new Promise((resolve) => {
    const done = () => {
      out.off('drain', done)
      out.off('close', done)
      out.off('error', done)
      if (signal) signal.removeEventListener('abort', done)
      resolve()
    }
    out.on('drain', done)
    out.on('close', done)
    out.on('error', done)
    if (signal) signal.addEventListener('abort', done)
  })
}

export class UserData {
  constructor (users, key, log, person = null) {
    this.users = users
    this.key = key
    this.log = log
    this.file = log.file
    if (person !== null) log.person = person
    // No change is taken any more: the person's data went (merged away, removed)...
    this._discarded = false
    // ... or this instance left memory (its next open is another instance), its data as it
    // was then kept for whatever still reads it.
    this._dropped = false
    this._frozen = null
  }

  /** The person in memory. */
  get p () {
    return this._frozen !== null ? this._frozen : this.log.person
  }

  /** The person's version (0 while it has no log). */
  get version () {
    return this.log.version
  }

  /** The epoch of that version (the zero epoch while it has no log). */
  get epoch () {
    return this.log.exists ? this.log.epoch : ZERO_EPOCH
  }

  /** Playlist id -> playlist; trackIds reads as 24 hex. */
  get playlists () {
    return this.p.playlists
  }

  /** The likes, newest first, { id, at } (made on each read). */
  get likes () {
    return this.p.likesList()
  }

  get recents () {
    return this.p.recents
  }

  /** Playlist id -> { small, large }. */
  get playlistCovers () {
    return this.p.covers
  }

  // The person's data from a .json of the format before, written as a new log (a migration).
  // False when the disk refused it (written again at the first change).
  _migrateFrom (data, from) {
    const v0 = data && typeof data === 'object' && Number.isSafeInteger(data.version) && data.version > 0 ? data.version : 1
    const e = Math.max(v0 + 1, Date.now())
    const log = this.log
    log.person = Person.fromJson(data, e)
    log.version = e
    log.epochs = [{ id: newEpochId(), first: e, last: e }]
    log.runEpoch = log.epochs[0].id
    log.from = from
    try {
      log.writeWholeSync(log.person, { v: e, epochs: log.epochs, from })
      return true
    } catch (err) {
      logError(path.basename(log.file) + ' not written from ' + this.key + '.json (tried again at the first change): ' + err.message)
      return false
    }
  }

  /** Data in the format of a .json before logs (the owner's from an old db.json): migrated now. */
  load (data) {
    if (data === null || data === undefined) return
    this._migrateFrom(data, null)
  }

  _data () {
    return {
      ...this.p.extra,
      schema: 1,
      version: this.version,
      playlists: [...this.p.playlists.values()].map(publicPlaylist),
      likes: this.p.likesList(),
      recents: this.p.recents,
      covers: { ...this.p.coversExtra, playlist: this.playlistCoversSnapshot() }
    }
  }

  playlistCoversSnapshot () {
    return this.p.coversObject()
  }

  /** The user part of GET /api/library: the newest 50 plays only; likes made when serialized. */
  snapshot () {
    return {
      playlists: [...this.p.playlists.values()],
      likes: new LikesView(this),
      recents: this.p.recents.slice(0, MAX_RECENTS),
      playlist: this.playlistCoversSnapshot()
    }
  }

  /** A playlist as it leaves the person: trackIds as 24 hex, its fields in today's order. */
  publicPlaylist (p) {
    return publicPlaylist(p)
  }

  /**
   * What changed since (epoch, u), or null when the client's versions are not known (then the
   * whole user part). `edits`: long playlists changed only by a few adds and removals come as
   * their ops (the rest of the playlists in `changed`).
   */
  changesSince (epoch, u, { edits = false } = {}) {
    if (!this.log.exists || !this.log.known(epoch, u)) return null
    return { version: this.version, epoch: this.epoch, ...this.p.changes(u, { edits }) }
  }

  /** The whole likes list as JSON (newest first), in slices of 5,000 with backpressure. */
  async writeLikes (out, { signal = null } = {}) {
    const p = this.p
    const l = p.likes
    l.walkers++
    try {
      let s = l.n - 1
      let first = true
      let parts = ['[']
      while (s >= 0) {
        for (let k = 0; s >= 0 && k < LIKES_SLICE; s--) {
          if (s >= l.n) {
            s = l.n
            continue
          }
          if (Number.isNaN(l.at[s])) continue
          parts.push((first ? '{"id":"' : ',{"id":"') + p.table.hex(l.idx[s]) + '","at":' + JSON.stringify(l.at[s]) + '}')
          first = false
          k++
        }
        if (s >= 0) {
          if (!out.write(parts.join(''))) await drained(out, signal)
          parts = []
          if (signal && signal.aborted) return false
        }
      }
      parts.push(']')
      out.write(parts.join(''))
      return true
    } finally {
      l.walkers--
    }
  }

  // ---------------------------------------------------------------- writes

  // A person without a log yet (new, or a migration that could not be written) gets one.
  _ensureLog () {
    const log = this.log
    if (log.exists) return
    try {
      log.writeWholeSync(this.p, { v: log.version, epochs: log.epochs, from: log.from })
    } catch (err) {
      logError(path.basename(log.file) + ' not created: ' + err.message)
      throw diskError(err)
    }
  }

  // One batch of changes, written then applied. prep[k], when given, gives the id indexes of
  // change k once it is written.
  _commit (ops, prep = null) {
    if (this._discarded || this._dropped) throw new HttpError(500, INTERNAL)
    this._ensureLog()
    const p = this.p
    return this.log.commit(ops, (r, k) => p.apply(r, null, prep !== null && prep[k] ? prep[k]() : null))
  }

  flush () {
    this.log.syncNow()
  }

  /** Synced now. */
  flushNow () {
    this.log.syncNow()
  }

  close () {
    this.log.close()
  }

  discard () {
    this._discarded = true
    this.log.close()
  }

  // -------------------------------------------------------------- playlists

  playlist (id) {
    if (!isPlaylistId(id)) throw new HttpError(400, 'Identificativo della playlist non valido')
    const p = this.p.playlists.get(id)
    if (!p) throw new HttpError(404, 'Playlist non trovata')
    return p
  }

  _trackIdList (list) {
    if (!Array.isArray(list)) throw new HttpError(400, 'Elenco di brani non valido')
    if (list.length > MAX_PLAYLIST_LENGTH) throw new HttpError(400, 'Troppi brani')
    for (const id of list) {
      if (!isTrackId(id)) throw new HttpError(400, 'Identificativo del brano non valido')
    }
    return list.slice()
  }

  createPlaylist (body = {}) {
    let id = null
    if (body.id !== undefined && body.id !== null) {
      if (!isPlaylistId(body.id)) throw new HttpError(400, 'Identificativo della playlist non valido')
      if (this.users.playlistIdTaken(body.id)) throw apiError('playlist_exists')
      id = body.id
    }
    if (this.p.playlists.size >= MAX_PLAYLISTS) throw new HttpError(400, 'Troppe playlist')
    let name = body.name === undefined || body.name === null ? '' : text(body.name, 200)
    if (!name) name = 'La mia playlist n. ' + (this.p.playlists.size + 1)
    const description = body.description === undefined || body.description === null ? '' : text(body.description, 1000)
    if (id === null) {
      do id = crypto.randomBytes(8).toString('hex')
      while (this.users.playlistIdTaken(id))
    }
    const now = Date.now()
    this._commit([{ o: 'pc', p: { id, name, description, trackIds: [], createdAt: now, updatedAt: now } }])
    return this.p.playlists.get(id)
  }

  /**
   * body: { name?, description?, trackIds?, base? }. trackIds is the full new order; with base,
   * the list that order was made from, it is applied to the list as it is now (rebaseOrder):
   * what another device or an earlier request changed since is kept.
   */
  updatePlaylist (id, body = {}) {
    const p = this.playlist(id)
    const op = { o: 'pu', id }
    if (body.name !== undefined) {
      op.name = text(body.name, 200)
      if (!op.name) throw new HttpError(400, "Il nome non puo' essere vuoto")
    }
    if (body.description !== undefined) op.description = body.description === null ? '' : text(body.description, 1000)
    let prep = null
    if (body.trackIds !== undefined) {
      const res = new Resolver(this.p.table)
      let ids = this._trackIdList(body.trackIds).map((h) => res.idx(h))
      if (body.base !== undefined && body.base !== null) {
        ids = rebaseOrder(p[IDS], this._trackIdList(body.base).map((h) => res.idx(h)), ids)
        if (ids.length > MAX_PLAYLIST_LENGTH) throw new HttpError(400, 'Playlist troppo lunga')
      }
      if (this.p.entries - p[IDS].length + ids.length > this.users.maxEntries) throw new HttpError(400, 'Troppi brani nelle playlist')
      op.trackIds = ids.map((i) => res.hex(i))
      prep = [() => res.real(ids)]
    }
    op.at = Date.now()
    this._commit([op], prep)
    return p
  }

  addToPlaylist (id, trackIds, position) {
    const p = this.playlist(id)
    const ids = this._trackIdList(trackIds)
    if (ids.length === 0) throw new HttpError(400, 'Nessun brano da aggiungere')
    const len = p[IDS].length
    if (len + ids.length > MAX_PLAYLIST_LENGTH) throw new HttpError(400, 'Playlist troppo lunga')
    if (this.p.entries + ids.length > this.users.maxEntries) throw new HttpError(400, 'Troppi brani nelle playlist')
    let pos = len
    if (position !== undefined && position !== null) {
      if (!Number.isInteger(position) || position < 0) throw new HttpError(400, 'Posizione non valida')
      pos = Math.min(position, len)
    }
    this._commit([{ o: 'pa', id, pos, ids, at: Date.now() }])
    return p
  }

  /**
   * Removes the songs at these positions. With ids (the track id the client saw at each
   * position) a position is checked against the list as it is now: a song that moved is removed
   * where it is now (its nearest place), one already gone is left alone, and no other song is
   * ever removed in its place. With counts (how many copies of each id the client's list had),
   * a copy gone since counts as one of those asked: a song in the list twice, whose copy another
   * device already removed, keeps its other copy.
   */
  removeFromPlaylist (id, indexes, ids, counts) {
    const p = this.playlist(id)
    const len = p[IDS].length
    if (!Array.isArray(indexes) || indexes.length === 0) throw new HttpError(400, 'Elenco di posizioni non valido')
    const checked = ids !== undefined && ids !== null
    const counted = counts !== undefined && counts !== null
    if (checked && (!Array.isArray(ids) || ids.length !== indexes.length)) throw new HttpError(400, 'Elenco di brani non valido')
    if (counted && (!checked || !Array.isArray(counts) || counts.length !== indexes.length)) throw new HttpError(400, 'Elenco di copie non valido')
    indexes.forEach((i, k) => {
      if (!Number.isInteger(i) || i < 0 || (!checked && i >= len)) throw new HttpError(400, 'Posizione non valida')
      if (checked && !isTrackId(ids[k])) throw new HttpError(400, 'Identificativo del brano non valido')
      if (counted && !(Number.isInteger(counts[k]) && counts[k] >= 1 && counts[k] <= MAX_PLAYLIST_LENGTH)) throw new HttpError(400, 'Elenco di copie non valido')
    })
    let drop
    if (checked) {
      const res = new Resolver(this.p.table)
      drop = removalSlots(p[IDS], indexes, ids.map((h) => res.idx(h)), counted ? counts : null)
    } else drop = new Set(indexes)
    if (drop.size === 0) return p
    this._commit([{ o: 'pr', id, idx: [...drop].sort((a, b) => a - b), at: Date.now() }])
    return p
  }

  deletePlaylist (id) {
    this.playlist(id)
    const entry = this.p.covers.get(id)
    const released = entry ? [entry.small, entry.large] : []
    this._commit([{ o: 'pd', id }])
    for (const cover of released) if (cover) this.users.releaseCover(cover)
  }

  // ------------------------------------------------------------ likes, plays

  _liked (trackId) {
    return this.p.likes.has(this.p.table.find(trackId))
  }

  /** The like (as the newest); the answer serializes the whole list. */
  like (trackId) {
    if (!isTrackId(trackId)) throw new HttpError(400, 'Identificativo del brano non valido')
    if (!this._liked(trackId)) {
      if (this.p.likes.live >= this.users.maxLikes) throw new HttpError(400, 'Troppi brani piaciuti')
      this._commit([{ o: 'l', id: trackId, at: Date.now() }])
    }
    return new LikesView(this)
  }

  unlike (trackId) {
    if (!isTrackId(trackId)) throw new HttpError(400, 'Identificativo del brano non valido')
    if (this._liked(trackId)) this._commit([{ o: 'u', id: trackId }])
    return new LikesView(this)
  }

  /**
   * Many likes at once ({ add, remove }, at most 5,000 ids in all): the removes unliked, then
   * the adds liked in the given order, each as the newest, all at this request's time; an id
   * already liked and not removed here stays where it is; an id in both lists is removed then
   * added. One version, one line. { added, removed }: the ids actually added and removed.
   */
  bulkLikes (body) {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw apiError('bad_request')
    const add = body.add === undefined ? [] : body.add
    const remove = body.remove === undefined ? [] : body.remove
    if (!Array.isArray(add) || !Array.isArray(remove) || add.length + remove.length > MAX_BULK_LIKES) throw apiError('bad_request')
    for (const id of remove) if (!isTrackId(id)) throw new HttpError(400, 'Identificativo del brano non valido')
    for (const id of add) if (!isTrackId(id)) throw new HttpError(400, 'Identificativo del brano non valido')
    const removing = new Set(remove)
    const rm = []
    for (const id of removing) if (this._liked(id)) rm.push(id)
    const seen = new Set()
    const adds = []
    for (const id of add) {
      if (seen.has(id)) continue
      seen.add(id)
      if (this._liked(id) && !removing.has(id)) continue
      adds.push(id)
    }
    if (this.p.likes.live - rm.length + adds.length > this.users.maxLikes) throw new HttpError(400, 'Troppi brani piaciuti', 'too_many_likes')
    if (rm.length === 0 && adds.length === 0) return { added: 0, removed: 0 }
    const now = Date.now()
    this._commit([{ o: 'lb', add: adds.map((id) => [id, now]), rm }])
    return { added: adds.length, removed: rm.length }
  }

  /**
   * A play, possibly of a track of another source. `at` (ms) is kept when it lies
   * within the last 30 days; otherwise the server's clock is used. Recents stay
   * sorted newest first.
   */
  played (trackId, context, at) {
    if (!isTrackId(trackId)) throw new HttpError(400, 'Identificativo del brano non valido')
    let ctx = { type: 'library' }
    if (context !== undefined && context !== null) {
      if (typeof context !== 'object' || Array.isArray(context) || !CONTEXT_TYPES.has(context.type)) {
        throw new HttpError(400, 'Contesto non valido')
      }
      ctx = { type: context.type }
      if (context.id !== undefined && context.id !== null) {
        if (typeof context.id !== 'string' || context.id.length > 200) throw new HttpError(400, 'Contesto non valido')
        ctx.id = context.id
      }
    }
    if (at !== undefined && at !== null && (typeof at !== 'number' || !Number.isFinite(at))) {
      throw new HttpError(400, 'Momento non valido')
    }
    const now = Date.now()
    let when = now
    if (typeof at === 'number' && at >= now - PLAYED_AT_MAX_AGE && at <= now + PLAYED_AT_MAX_SKEW) when = Math.min(Math.round(at), now)
    const recents = this.p.recents
    let i = 0
    while (i < recents.length && recents[i].at > when) i++
    if (i >= MAX_HISTORY) return
    this._commit([{ o: 'r', r: { trackId, at: when, context: ctx } }])
  }

  /**
   * GET /api/recents: the plays older than `before` (ms; null: from the newest),
   * newest first, at most `limit`; `more` when older ones are left.
   */
  recentsPage (before, limit) {
    const recents = this.p.recents
    let i = 0
    if (before !== null) while (i < recents.length && recents[i].at >= before) i++
    const page = recents.slice(i, i + limit).map((r) => ({ trackId: r.trackId, at: r.at, context: { ...r.context } }))
    return { recents: page, more: i + limit < recents.length }
  }

  /** A track file is gone from the source: out of this person's data. */
  removeTrack (id) {
    this.removeTracks([id], Date.now())
  }

  /** Track files gone: one change takes their ids out of the playlists, likes and plays. */
  removeTracks (hexIds, at) {
    const t = this.p.table
    const idx = new Set()
    for (const h of hexIds) {
      const i = t.find(h)
      if (i >= 0) idx.add(i)
    }
    const pl = []
    if (idx.size > 0) {
      for (const [pid, p] of this.p.playlists) {
        const a = p[IDS]
        let positions = null
        for (let k = 0; k < a.length; k++) {
          if (!idx.has(a[k])) continue
          if (positions === null) positions = []
          positions.push(k)
        }
        if (positions !== null) pl.push([pid, positions])
      }
    }
    let likes = false
    for (const i of idx) if (this.p.likes.has(i)) likes = true
    const gone = new Set(hexIds)
    const plays = this.p.recents.some((r) => gone.has(r.trackId))
    if (pl.length === 0 && !likes && !plays) return
    this._commit([{ o: 'x', ids: [...gone], pl, at }])
  }

  // ------------------------------------------------------- playlist covers

  setPlaylistCover (id, size, coverId) {
    this.playlist(id)
    if (!COVER_SIZES.includes(size)) throw new HttpError(400, 'Dimensione non valida')
    const entry = this.p.covers.get(id)
    const previous = entry ? entry[size] : null
    this._commit([{ o: 'cs', id, size, cover: coverId }])
    if (previous && previous !== coverId) this.users.releaseCover(previous)
  }

  clearPlaylistCover (id) {
    this.playlist(id)
    const entry = this.p.covers.get(id)
    if (!entry) return
    const released = [entry.small, entry.large]
    this._commit([{ o: 'cc', id }])
    for (const cover of released) if (cover) this.users.releaseCover(cover)
  }

  /** Forget playlist covers whose image is gone (deleted by hand). */
  dropMissingCovers (exists) {
    const ops = []
    for (const [id, entry] of this.p.covers) {
      const sizes = COVER_SIZES.filter((size) => entry[size] !== null && !exists(entry[size]))
      if (sizes.length > 0) ops.push({ o: 'cc', id, sizes })
    }
    if (ops.length > 0) this._commit(ops)
  }

  // ------------------------------------------------------------- sweeps

  /**
   * A removal swept (a generator, one step per playlist; Users runs it in slices): the
   * positions holding the ids are found on the arrays as they are, new arrays made and the
   * live ones never touched; then, at once, _swept().
   */
  * _sweep ({ ids, at }) {
    const p = this.p
    const t = p.table
    const idx = new Set()
    for (const h of ids) {
      const i = t.find(h)
      if (i >= 0) idx.add(i)
    }
    const read = new Map() // playlist id -> the array the walk read
    const found = new Map() // playlist id -> { positions, list } where the walk found ids
    if (idx.size > 0) {
      for (const pid of [...p.playlists.keys()]) {
        const pl = p.playlists.get(pid)
        if (pl !== undefined) {
          read.set(pid, pl[IDS])
          const f = withoutIds(pl[IDS], idx)
          if (f !== null) found.set(pid, f)
        }
        yield
      }
    }
    this._swept(ids, at, idx, read, found)
  }

  // The end of a sweep, with nothing awaited: a playlist whose array is still the one read
  // takes the new one; one changed meanwhile is filtered again now; the likes and plays of the
  // ids go; one line, one version.
  _swept (ids, at, idx, read, found) {
    if (this._discarded || this._dropped) return
    const p = this.p
    const pl = []
    const pre = new Map()
    for (const [pid, a] of read) {
      const cur = p.playlists.get(pid)
      if (cur === undefined) continue
      const f = cur[IDS] === a ? found.get(pid) : withoutIds(cur[IDS], idx)
      if (f === undefined || f === null) continue
      pl.push([pid, f.positions])
      pre.set(pid, f.list)
    }
    let likes = false
    for (const i of idx) if (p.likes.has(i)) likes = true
    const gone = new Set(ids)
    const plays = p.recents.some((r) => gone.has(r.trackId))
    if (pl.length === 0 && !likes && !plays) return
    try {
      this._commit([{ o: 'x', ids: [...gone], pl, at }], [() => pre])
    } catch (err) {
      logError('tracks not removed from the data of ' + this.key + ': ' + err.message)
    }
  }

  // ------------------------------------------------------------- merges

  /**
   * `from`'s data joined into this person (see Users.merge) as one change: the reset line, whose
   * version is then on everything of this person, written first, the merge applied once it is.
   * `map`: A's ids interned here ahead (Person.internAhead). `probe(step)` is called between
   * the steps of the merge (checks). The version, or null when the line could not be written
   * (then nothing changed).
   */
  mergeFrom (from, probe = null, map = null) {
    if (this._discarded || this._dropped) return null
    const to = this.p
    const src = from.p
    try {
      this._ensureLog()
      return this.log.commit([{ o: 'z' }], (r) => {
        to.mergeFrom(src, r.v, probe, map)
        to.apply(r)
      })
    } catch (err) {
      logError(path.basename(this.log.file) + ': the merge of ' + from.key + ' not written: ' + err.message)
      return null
    }
  }

  // ------------------------------------------------------------- export

  /**
   * This person's .json in the format before (an older MPfy reads it), written from the log
   * in pieces, never as one string: by a temporary file, synced, renamed; then the log knows
   * that .json (export-compat, with the server stopped).
   */
  async exportJson () {
    const fsx = this.users.fsx
    const file = this.users.jsonOf(this.key)
    const tmp = file + '.tmp'
    const p = this.p
    const fd = fsx.openSync(tmp, 'w', 0o600)
    const hash = crypto.createHash('sha256')
    let parts = []
    let bytes = 0
    const put = async (text, last = false) => {
      parts.push(text)
      bytes += text.length
      if (bytes < EXPORT_SLICE_BYTES && !last) return
      const buf = Buffer.from(parts.join(''), 'utf8')
      hash.update(buf)
      parts = []
      bytes = 0
      for (let off = 0; off < buf.length;) {
        const n = fsx.writeSync(fd, buf, off, buf.length - off)
        if (n <= 0) throw Object.assign(new Error('short write'), { code: 'ENOSPC' })
        off += n
      }
      if (!last) await tick()
    }
    const l = p.likes
    l.walkers++
    try {
      await put(JSON.stringify({ ...p.extra, schema: 1, version: this.version }).slice(0, -1) + ',"playlists":[')
      let first = true
      for (const pl of p.playlists.values()) {
        await put((first ? '' : ',') + JSON.stringify(publicPlaylist(pl)))
        first = false
      }
      await put('],"likes":[')
      first = true
      for (let s = l.n - 1, k = 0; s >= 0; s--) {
        if (Number.isNaN(l.at[s])) continue
        await put((first ? '{"id":"' : ',{"id":"') + p.table.hex(l.idx[s]) + '","at":' + JSON.stringify(l.at[s]) + '}')
        first = false
        if (++k % LIKES_SLICE === 0) await tick()
      }
      await put('],"recents":' + JSON.stringify(p.recents) + ',"covers":' + JSON.stringify({ ...p.coversExtra, playlist: p.coversObject() }) + '}', true)
      await new Promise((resolve, reject) => fsx.fsync(fd, (err) => (err ? reject(err) : resolve())))
    } catch (err) {
      try {
        fsx.closeSync(fd)
      } catch {}
      unlinkQuiet(tmp)
      throw err
    } finally {
      l.walkers--
    }
    fsx.closeSync(fd)
    fsx.renameSync(tmp, file)
    fsx.fsyncDir(path.dirname(file))
    const st = fs.statSync(file)
    this.log.noteExport({ size: st.size, mtimeMs: st.mtimeMs, hash: hash.digest('hex') })
    this.log.syncNow()
  }
}

// The list without the ids of `idx` (id indexes): { positions, list }, or null when it holds none.
function withoutIds (a, idx) {
  let positions = null
  let list = null
  for (let k = 0; k < a.length; k++) {
    if (!idx.has(a[k])) {
      if (list !== null) list.push(a[k])
      continue
    }
    if (positions === null) {
      positions = []
      list = a.slice(0, k)
    }
    positions.push(k)
  }
  return positions === null ? null : { positions, list }
}

// A string field from a request: must be a string, trimmed, control characters
// removed, capped at `max` characters.
export function text (value, max) {
  if (typeof value !== 'string') throw new HttpError(400, 'Valore non valido')
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max)
}
