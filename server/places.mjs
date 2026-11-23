// Where a source keeps its track files: internal memory (the data dir, always
// there) and at most one memory card, chosen by the owner. Each place holds the
// same tree:
//   library/<ab>/<trackId>.<ext>             originals
//   transcodes/<ab>/<trackId>.<level>.opus   Opus levels
//   tmp/                                     copies coming in, files set aside
// with <ab> the first two hex of the track id: 256 shards, because a FAT32
// folder takes at most 16,383 files of our names, and every create and every
// look-up of a missing name scans the whole folder. Everything that is not a
// track file stays in internal memory.
//
// The card is used as Android mounts it (FAT32 or exFAT, never formatted). Its
// root, <cards>/<volume>/<folder>, holds place.json, a marker whose random id
// source.json keeps: a folder without it, or with another id, is never written
// and its files are never adopted. The root is made only by the owner's choice;
// every other folder made on a card is one level under a root whose marker was
// read in the current ready state.
//
// Card calls are asynchronous and go through one gate, at most 2 in flight, so
// a card that hangs never takes every thread of the pool (the run script sets
// UV_THREADPOOL_SIZE=8). A call that waits or runs over 5 s makes the card
// suspect. No file of the card is held open across a wait: reads and writes are
// made in chunks, each with its own short open, and external tools (ffmpeg,
// fpcalc) never open a card file. Internal memory keeps the synchronous helpers
// of the rest of the data dir.
//
// The card's state: ready (the marker read with our id), readonly (a write
// failed with EROFS), pending (at start, the marker not readable yet, for at
// most 60 s), away. `listed` is the state the library's codes read: it follows
// `away` only once the card stayed away 60 s, so a quick flap writes nothing.
// Nothing runs at rest: the card is noticed by the folder events of <cards>, by
// the errors of its calls, and on demand (a request for an away track, the
// owner's row or command, health), at most once per 30 s.

import { EventEmitter } from 'node:events'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { isTrackId, LIBRARY_FILE_RE, TRANSCODE_FILE_RE, LEVELS } from './ids.mjs'
import { Disk, cardFloor } from './disk.mjs'
import { apiError } from './errors.mjs'
import { renameSyncRetry, fsyncDirSync, asidePath, unlinkQuiet, log, logError } from './util.mjs'

export const SHARDS = 256
export const VOLUME_RE = /^[0-9A-Za-z][0-9A-Za-z-]{0,35}$/
export const PACKAGE_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/
const CARD_ID_RE = /^[0-9a-f]{32}$/
const SHARD_RE = /^[0-9a-f]{2}$/
const MARKER = 'place.json'
const NOMEDIA = '.nomedia'
export const ROOT_FOLDER = 'MPfy'

export const CODE = { unknown: 0, internal: 1, card: 2 }
const GRACE_MS = 60 * 1000 // the card may show this long after a start (and a flap writes nothing for this long)
const ON_DEMAND_MS = 30 * 1000 // the marker read again on demand at most this often
const CONFIRM_MS = 2000 // ready again only after the marker read back twice this far apart
const CALL_MS = 5000 // a card call waiting or running longer makes the card suspect
const GATE_LIMIT = 2
const AFTER_EVENT_MS = [2000, 5000, 15000, 30000] // the mount follows the folder
const NAMES_SLICE = 500
const LIST_IN_FLIGHT = 8
const MIGRATE_SLICE = 64
const CHUNK = 1024 * 1024
const FLUSH_EVERY = 4 * 1024 * 1024
const STREAM_QUIET_MS = 10 * 1000 // the move waits this long after the last card stream
const HEALTH_WAIT_MS = 100
const SUSPICIOUS = new Set(['EIO', 'ENXIO', 'ENODEV', 'ESTALE', 'EROFS', 'EACCES', 'ETIMEDOUT', 'ECARDAWAY'])

/** The shard of a track id: its first two hex. */
export function shardOf (id) {
  if (!isTrackId(id)) throw new Error('invalid track id')
  return id.slice(0, 2)
}

/** Is `card` (source.json) well formed? */
export function validCard (card) {
  if (!card || typeof card !== 'object' || Array.isArray(card) || card.invalid === true) return false
  if (typeof card.volume !== 'string' || !VOLUME_RE.test(card.volume) || card.volume === 'emulated' || card.volume === 'self') return false
  if (!validFolder(card.folder)) return false
  return typeof card.id === 'string' && CARD_ID_RE.test(card.id) && Number.isFinite(card.chosenAt) && typeof card.leaving === 'boolean'
}

function validFolder (folder) {
  if (folder === ROOT_FOLDER) return true
  const m = typeof folder === 'string' ? /^Android\/data\/([^/]+)\/files\/MPfy$/.exec(folder) : null
  return m !== null && PACKAGE_RE.test(m[1])
}

/** The folder of the cards: MPFY_CARDS, else /storage when it exists (no root), else none. */
export function defaultCardsDir () {
  if (process.env.MPFY_CARDS) return path.resolve(process.env.MPFY_CARDS)
  try {
    if (process.platform !== 'win32' && fs.statSync('/storage').isDirectory()) return '/storage'
  } catch {}
  return null
}

function packageName () {
  const prefix = process.env.PREFIX || ''
  const m = /^\/data\/data\/([^/]+)\/files\/usr\/?$/.exec(prefix)
  return m !== null && PACKAGE_RE.test(m[1]) ? m[1] : 'com.termux'
}

function codeError (code, message) {
  return Object.assign(new Error(message || code), { code })
}

/** Drop the cached pages of a file (GNU dd's nocache), so a read comes from the medium. */
export function ddNocache (file) {
  return new Promise((resolve, reject) => {
    const child = spawn('dd', ['if=' + file, 'iflag=nocache', 'count=0'], { stdio: 'ignore' })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error('dd ended with ' + code)))
  })
}

/** The calls places make (tests replace some). */
export const PLACE_IO = {
  // internal memory: synchronous, as the rest of the data dir
  renameSync: (a, b) => renameSyncRetry(a, b),
  unlinkSync: (p) => fs.unlinkSync(p),
  // the card: asynchronous, through the gate
  rename: (a, b) => fs.promises.rename(a, b),
  mkdir: (p) => fs.promises.mkdir(p),
  readdir: (p) => fs.promises.readdir(p),
  stat: (p) => fs.promises.stat(p),
  devOf: async (p) => (await fs.promises.stat(p)).dev,
  statfs: (p) => fs.promises.statfs(p),
  unlink: (p) => fs.promises.unlink(p),
  rmdir: (p) => fs.promises.rmdir(p),
  access: (p, mode) => fs.promises.access(p, mode),
  readFile: (p) => fs.promises.readFile(p),
  open: (p, flags, mode) => fs.promises.open(p, flags, mode),
  watch: (dir, fn) => fs.watch(dir, fn),
  dropCache: ddNocache
}

// At most `limit` calls in flight; the others wait in JS, where a timeout can
// drop them. A call over `timeoutMs` (waiting or running) is reported slow.
class Gate {
  constructor ({ limit, timeoutMs, onSlow }) {
    this.limit = limit
    this.timeoutMs = timeoutMs
    this.onSlow = onSlow
    this.inFlight = 0
    this.queue = []
  }

  run (fn) {
    return new Promise((resolve, reject) => {
      const item = { fn, resolve, reject, done: false, started: false, timer: null }
      item.timer = setTimeout(() => {
        if (item.done) return
        item.done = true
        if (!item.started) this.queue.splice(this.queue.indexOf(item), 1)
        reject(codeError('ETIMEDOUT', 'card call over ' + this.timeoutMs + ' ms'))
        this.onSlow()
      }, this.timeoutMs)
      item.timer.unref()
      this.queue.push(item)
      this._pump()
    })
  }

  _pump () {
    while (this.inFlight < this.limit && this.queue.length > 0) {
      const item = this.queue.shift()
      item.started = true
      this.inFlight++
      Promise.resolve().then(item.fn).then((v) => {
        if (item.done) return
        item.done = true
        clearTimeout(item.timer)
        item.resolve(v)
      }, (err) => {
        if (item.done) return
        item.done = true
        clearTimeout(item.timer)
        item.reject(err)
      }).finally(() => {
        // The thread is free only when the call ends, whatever the timer said.
        this.inFlight--
        this._pump()
      })
    }
  }

  /** Every call still waiting fails with `err` (the card went away). */
  failWaiting (err) {
    const waiting = this.queue
    this.queue = []
    for (const item of waiting) {
      item.done = true
      clearTimeout(item.timer)
      item.reject(err)
    }
  }
}

export class Place {
  constructor ({ kind, root, code, disk }) {
    this.kind = kind
    this.code = code
    this.root = root
    this.disk = disk
    this.state = kind === 'internal' ? 'ready' : 'pending'
    this.listed = this.state
    this.libraryDir = root === null ? null : path.join(root, 'library')
    this.transcodesDir = root === null ? null : path.join(root, 'transcodes')
    this.tmpDir = root === null ? null : path.join(root, 'tmp')
    this.uploadsDir = root === null ? null : path.join(root, 'uploads')
    this.pendingDir = root === null ? null : path.join(root, 'pending')
    this._made = new Set() // shard folders known to exist
  }

  /** Can its files be read now (ready, or a card switched to read-only)? */
  get readable () {
    return this.state === 'ready' || this.state === 'readonly'
  }

  get ready () {
    return this.state === 'ready'
  }

  treeDir (tree) {
    return tree === 'transcodes' ? this.transcodesDir : this.libraryDir
  }

  /** <root>/library/<ab>/<name>, `name` a track file name. */
  libraryPath (name) {
    const m = LIBRARY_FILE_RE.exec(name)
    if (m === null) throw new Error('invalid track file name')
    return path.join(this.libraryDir, m[1].slice(0, 2), name)
  }

  /** <root>/transcodes/<ab>/<id>.<level>.opus */
  transcodePath (id, level) {
    if (!LEVELS[level]) throw new Error('invalid level')
    return path.join(this.transcodesDir, shardOf(id), id + '.' + level + '.opus')
  }

  /** The path of a file of `tree` (`name` a library or transcode file name). */
  pathOf (tree, name) {
    return path.join(this.treeDir(tree), name.slice(0, 2), name)
  }
}

export class Places extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir
   * @param {string|null} [opts.cardsDir]  where the cards are mounted (MPFY_CARDS)
   * @param {object|null} [opts.source]  the SourceStore (its `card`, read once here)
   * @param {() => string|null} [opts.serverPublicKey]  hex, for the marker's `source`
   * @param {import('./disk.mjs').Disk} [opts.disk]  internal memory's
   * @param {number|null} [opts.cardMinFreeBytes]  null: max(1 GiB, 2% of the card)
   * @param {object} [opts.io]  replaces calls of PLACE_IO (tests)
   */
  constructor ({
    dataDir, cardsDir = defaultCardsDir(), source = null, serverPublicKey = () => null, disk = null, minFreeBytes = null,
    cardMinFreeBytes = envBytes('MPFY_CARD_MIN_FREE_BYTES'), statfs = null, io = {}, now = Date.now, graceMs = GRACE_MS,
    pollMs = ON_DEMAND_MS, confirmMs = CONFIRM_MS, callMs = CALL_MS, afterEventMs = AFTER_EVENT_MS, watch = true,
    streamQuietMs = STREAM_QUIET_MS
  }) {
    super()
    this.dataDir = path.resolve(dataDir)
    this.cardsDir = cardsDir === null ? null : path.resolve(cardsDir)
    this.source = source
    this.serverPublicKey = serverPublicKey
    this.io = { ...PLACE_IO, ...io }
    this.now = now
    this.graceMs = graceMs
    this.pollMs = pollMs
    this.confirmMs = confirmMs
    this.afterEventMs = afterEventMs
    this.watchCards = watch
    this.streamQuietMs = streamQuietMs
    this.cardMinFreeBytes = cardMinFreeBytes
    this._statfs = statfs
    this.internal = new Place({
      kind: 'internal',
      root: this.dataDir,
      code: CODE.internal,
      disk: disk || new Disk({ dataDir: this.dataDir, minFreeBytes, ...(statfs ? { statfs } : {}) })
    })
    this.gate = new Gate({ limit: GATE_LIMIT, timeoutMs: callMs, onSlow: () => this.suspect(this.card, codeError('ETIMEDOUT')) })
    this.card = null
    this.setting = null // the card setting as source.json had it at start
    this._opened = null
    this._closed = false
    this._watcher = null
    this._timers = new Set()
    this._lastCheck = 0
    this._checking = null
    this._streams = new Set() // responses being sent from card files
    this._lastStreamAt = 0
    this.moving = null // { done, total } while the move job runs a pass
    this.blocked = null // { needBytes } when moving out lacks room
    this._loadSetting()
  }

  _loadSetting () {
    let card = null
    if (this.source !== null) {
      // A source.json that exists but cannot be read is not "no card".
      const data = this.source.exists() ? this.source.data : null
      card = data === null ? (this.source.exists() ? { invalid: true } : null) : (data.card === undefined ? null : data.card)
    }
    this.setting = card
    if (card === null) return
    if (!validCard(card)) {
      logError('source.json: the memory card setting is not valid: the card is not used until "card use" or "card forget"')
      this.card = this._newCard(null)
      this.card.invalid = true
      this.card.state = 'away'
      this.card.listed = 'away'
      return
    }
    this.card = this._newCard(card)
  }

  _newCard (card) {
    const root = card !== null && this.cardsDir !== null ? path.join(this.cardsDir, card.volume, ...card.folder.split('/')) : null
    const place = new Place({
      kind: 'card',
      root,
      code: CODE.card,
      disk: new Disk({
        dataDir: root || this.dataDir,
        minFreeBytes: this.cardMinFreeBytes,
        floorOf: cardFloor,
        failClosed: true,
        onFail: (err) => this.suspect(place, err),
        statfs: (dir) => this.cardCall(() => (this._statfs ? this._statfs(dir) : this.io.statfs(dir)))
      })
    })
    place.volume = card !== null ? card.volume : (this.setting && typeof this.setting.volume === 'string' ? this.setting.volume : null)
    place.folder = card !== null ? card.folder : null
    place.id = card !== null ? card.id : null
    place.leaving = card !== null && card.leaving === true
    place.invalid = false
    place.bad = false // a copy did not read back as written: nothing more is moved onto it
    place.full = false
    place._awaySince = 0
    place._listedTimer = null
    return place
  }

  /** The place of a code of the library (1 internal, 2 card), or null. */
  byCode (n) {
    if (n === CODE.internal) return this.internal
    if (n === CODE.card) return this.card
    return null
  }

  codeOf (place) {
    return place === null ? CODE.unknown : place.code
  }

  /** The place whose root holds `file` (a staged file), else internal memory. */
  placeOf (file) {
    const card = this.card
    if (card !== null && card.root !== null && isUnder(file, card.root)) return card
    return this.internal
  }

  /** Is a card configured (in source.json, valid or not)? */
  get configured () {
    return this.card !== null
  }

  // ---------------------------------------------------------------- start

  /** Internal memory ready; the card ready, or pending for up to the grace. */
  open () {
    if (this._opened === null) this._opened = this._open()
    return this._opened
  }

  async _open () {
    for (const dir of [this.internal.libraryDir, this.internal.transcodesDir, this.internal.tmpDir]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    }
    const card = this.card
    if (card === null || card.invalid || card.root === null) {
      if (card !== null && card.root === null && !card.invalid) {
        card.state = 'away'
        card.listed = 'away'
      }
      return
    }
    // The watch first: a card mounted between a check and a later watch would
    // give no event, and stay away for good after the grace.
    this._watch()
    this._lastCheck = this.now()
    if (await this._markerOk()) {
      card.state = 'ready'
      card.listed = 'ready'
      log('memory card ' + card.volume + ': ready')
      return
    }
    card.state = 'pending'
    card.listed = 'pending'
    this._later(this.graceMs, () => {
      if (card.state !== 'pending') return
      log('memory card ' + card.volume + ': not found ' + Math.round(this.graceMs / 1000) + ' s after the start')
      this._setState(card, 'away')
      this._setListed(card, 'away')
    })
  }

  _later (ms, fn) {
    if (this._closed) return null
    const t = setTimeout(() => {
      this._timers.delete(t)
      if (!this._closed) fn()
    }, ms)
    t.unref()
    this._timers.add(t)
    return t
  }

  _clear (t) {
    if (t === null) return
    clearTimeout(t)
    this._timers.delete(t)
  }

  _watch () {
    if (!this.watchCards || this.cardsDir === null || this._watcher !== null) return
    try {
      this._watcher = this.io.watch(this.cardsDir, (event, name) => this._onCardsEvent(name))
      if (this._watcher && typeof this._watcher.unref === 'function') this._watcher.unref()
      if (this._watcher && typeof this._watcher.on === 'function') this._watcher.on('error', () => {})
    } catch (err) {
      // Under /storage without root a watch may be refused: the card is then
      // looked at on demand only.
      this._watcher = null
    }
  }

  _onCardsEvent (name) {
    const card = this.card
    if (card === null || card.invalid || card.root === null) return
    if (name !== null && name !== undefined && String(name) !== card.volume) return
    const volumeDir = path.join(this.cardsDir, card.volume)
    fs.promises.stat(volumeDir).then(() => {
      // Made (or still there): the mount follows the folder.
      if (card.state === 'ready') return
      for (const ms of this.afterEventMs) this._later(ms, () => { if (card.state !== 'ready') this.recheck() })
    }, () => {
      // Removed: away at once.
      if (card.state !== 'away') this._toAway(card, 'its folder is gone')
    })
  }

  // ------------------------------------------------------------ the marker

  async _markerOk () {
    const card = this.card
    if (card === null || card.root === null || card.invalid) return false
    try {
      return await this.gate.run(async () => {
        const [dev, cardsDev] = await Promise.all([this.io.devOf(path.join(this.cardsDir, card.volume)), this.io.devOf(this.cardsDir)])
        if (dev === cardsDev) return false
        const marker = JSON.parse(String(await this.io.readFile(path.join(card.root, MARKER))))
        return !!marker && marker.mpfy === 'place' && marker.id === card.id
      })
    } catch {
      return false
    }
  }

  /** The marker read again now (tests call it directly): the card's state follows it. */
  recheck () {
    if (this._checking !== null) return this._checking
    this._checking = this._recheck().finally(() => { this._checking = null })
    return this._checking
  }

  async _recheck () {
    const card = this.card
    if (card === null || card.invalid || card.root === null || this._closed) return
    this._lastCheck = this.now()
    let ok = await this._markerOk()
    if (ok && !card.readable && this.confirmMs > 0) {
      // A flapping contact: ready again only when it reads back twice.
      await new Promise((resolve) => this._later(this.confirmMs, resolve) || resolve())
      ok = await this._markerOk()
    }
    if (this._closed) return
    if (ok) {
      if (!card.readable) this._toReady(card)
    } else if (card.state !== 'away') {
      this._toAway(card, 'its marker cannot be read')
    }
  }

  /** On demand (a request, the owner's row, health): the marker again, at most once per 30 s. */
  maybeRecheck () {
    const card = this.card
    if (card === null || card.invalid || card.readable || this._closed) return
    if (this.now() - this._lastCheck < this.pollMs) return
    this.recheck().catch(() => {})
  }

  /**
   * A card call failed with `err`: an I/O error, a missing shard or marker, a
   * read-only volume, or a call over its time make the card looked at again.
   */
  suspect (place, err) {
    if (place === null || place === undefined || place.kind !== 'card' || this._closed) return
    const code = err && err.code
    if (!SUSPICIOUS.has(code) && code !== 'ENOENT') return
    if (code === 'EROFS' && place.state === 'ready') {
      this._markerOk().then((ok) => {
        if (ok && place.state === 'ready') this._setState(place, 'readonly')
        else if (!ok && place.state !== 'away') this._toAway(place, 'a read-only card without its marker')
      })
      return
    }
    if (place.state === 'away') return
    this._markerOk().then((ok) => {
      if (!ok && place.state !== 'away') this._toAway(place, (code || 'an error') + ' and its marker cannot be read')
    })
  }

  _toAway (card, why) {
    log('memory card ' + card.volume + ' away: ' + why)
    card._awaySince = this.now()
    this._setState(card, 'away')
    this.gate.failWaiting(codeError('ECARDAWAY', 'memory card away'))
    // Serving stops at once: what is being sent from it is cut, so players fail over.
    for (const s of [...this._streams]) {
      s.destroy(codeError('ECARDAWAY', 'memory card away'))
      if (s.owner) s.owner.destroy()
    }
    this._streams.clear()
    if (card.listed === 'ready' && card._listedTimer === null) {
      card._listedTimer = this._later(this.graceMs, () => {
        card._listedTimer = null
        if (card.state === 'away') this._setListed(card, 'away')
      })
    }
  }

  _toReady (card) {
    log('memory card ' + card.volume + ': back')
    this._clear(card._listedTimer)
    card._listedTimer = null
    card.full = false
    this._setState(card, 'ready')
  }

  _setState (place, to) {
    const from = place.state
    if (from === to) return
    place.state = to
    this.emit('state', place, from, to)
  }

  /** The state the codes of the library read (set by the library once it listed the card). */
  _setListed (place, to) {
    const from = place.listed
    if (from === to) return
    place.listed = to
    this.emit('listed', place, from, to)
  }

  setListed (place, to) {
    this._setListed(place, to)
  }

  // ------------------------------------------------------------- card calls

  /** A call on the card, through the gate; its failure may make the card suspect. */
  async cardCall (fn, { write = false } = {}) {
    const card = this.card
    if (card === null || card.root === null || (write ? card.state !== 'ready' : !card.readable)) {
      throw codeError('ECARDAWAY', 'memory card not ready')
    }
    try {
      return await this.gate.run(fn)
    } catch (err) {
      if (err && err.code !== 'ENOENT') this.suspect(card, err)
      throw err
    }
  }

  // ---------------------------------------------------------------- layout

  /** A shard folder, made one level when not known yet (the tree's root must exist). */
  async ensureShard (place, tree, ab) {
    const dir = path.join(place.treeDir(tree), ab)
    if (place._made.has(dir)) return dir
    if (place.kind === 'internal') {
      try {
        fs.mkdirSync(dir, { mode: 0o700 })
      } catch (err) {
        if (err.code !== 'EEXIST') throw err
      }
    } else {
      await this._cardMkdir(place, place.treeDir(tree))
      await this._cardMkdir(place, dir)
    }
    place._made.add(dir)
    return dir
  }

  /** The same, synchronous: internal memory only. */
  ensureShardSync (place, tree, ab) {
    if (place.kind !== 'internal') throw new Error('a card shard is made asynchronously')
    const dir = path.join(place.treeDir(tree), ab)
    if (place._made.has(dir)) return dir
    try {
      fs.mkdirSync(dir, { mode: 0o700 })
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
    }
    place._made.add(dir)
    return dir
  }

  // One level under the card root, never recursive: a card gone while a path
  // was being built never makes us write into what is left at that path.
  async _cardMkdir (place, dir) {
    if (place._made.has(dir)) return
    try {
      await this.cardCall(async () => {
        try {
          await this.io.mkdir(dir)
        } catch (err) {
          if (err.code !== 'EEXIST') throw err
        }
      }, { write: true })
    } catch (err) {
      // Its parent missing: the root went with the card.
      if (err.code === 'ENOENT') this.suspect(place, err)
      throw err
    }
    place._made.add(dir)
  }

  /**
   * The names of `tree` on `place`, one shard after another (8 in flight on
   * internal memory, the gate's 2 on a card), handed to `onSlice` in slices of
   * 500 with a yield between them. Resolves { complete }: false when a shard
   * (or the tree) could not be read.
   */
  async list (place, tree, onSlice) {
    const top = place.treeDir(tree)
    const read = place.kind === 'internal' ? (dir) => fs.promises.readdir(dir) : (dir) => this.cardCall(() => this.io.readdir(dir))
    let shards
    try {
      shards = (await read(top)).filter((n) => SHARD_RE.test(n))
    } catch (err) {
      if (err.code === 'ENOENT' && (place.kind === 'internal' || await this._markerOk())) return { complete: true }
      return { complete: false }
    }
    let complete = true
    let i = 0
    const worker = async () => {
      while (i < shards.length) {
        const ab = shards[i++]
        let names
        try {
          names = await read(path.join(top, ab))
        } catch (err) {
          if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') complete = false
          continue
        }
        place._made.add(path.join(top, ab))
        for (let k = 0; k < names.length; k += NAMES_SLICE) {
          onSlice(names.slice(k, k + NAMES_SLICE), ab)
          await yieldNow()
        }
      }
    }
    const n = place.kind === 'internal' ? LIST_IN_FLIGHT : GATE_LIMIT
    await Promise.all(Array.from({ length: Math.min(n, shards.length) }, worker))
    return { complete }
  }

  /** The stats of `files` of `place`, 64 at a time with a yield between: [stat | null]. */
  async stats (place, files) {
    const out = new Array(files.length).fill(null)
    const stat = place.kind === 'internal' ? (f) => fs.promises.stat(f) : (f) => this.cardCall(() => this.io.stat(f))
    for (let k = 0; k < files.length; k += 64) {
      await Promise.all(files.slice(k, k + 64).map((f, j) => stat(f).then((st) => { out[k + j] = st }, () => {})))
      await yieldNow()
    }
    return out
  }

  /**
   * Today's flat library/ and transcodes/ move into their shards by renames,
   * crash-safe at each one; a flat file whose shard twin exists goes only when
   * both have the same size. Top-level .part and .tmp of transcodes/ go.
   * Returns the number of files moved.
   */
  async migrateFlat (place) {
    if (place.kind !== 'internal' && !place.ready) return 0
    let moved = 0
    for (const tree of ['library', 'transcodes']) {
      const dir = place.treeDir(tree)
      const re = tree === 'library' ? LIBRARY_FILE_RE : TRANSCODE_FILE_RE
      let entries
      try {
        entries = place.kind === 'internal' ? fs.readdirSync(dir) : await this.cardCall(() => this.io.readdir(dir))
      } catch {
        continue
      }
      const touched = new Set()
      let n = 0
      for (const name of entries) {
        if (SHARD_RE.test(name)) continue
        const from = path.join(dir, name)
        if (re.exec(name) === null) {
          if (tree === 'transcodes' && (name.endsWith('.part') || name.endsWith('.tmp'))) await this._unlink(place, from)
          continue
        }
        const shard = place.kind === 'internal' ? this.ensureShardSync(place, tree, name.slice(0, 2)) : await this.ensureShard(place, tree, name.slice(0, 2))
        const to = path.join(shard, name)
        const twin = await this._statOf(place, to)
        if (twin !== null) {
          const flat = await this._statOf(place, from)
          if (flat !== null && flat.isFile() && flat.size === twin.size) await this._unlink(place, from)
          else if (flat !== null && flat.isFile()) logError('places: ' + name + ' is in ' + tree + '/ and in its shard with another size: the flat one is left alone')
          continue
        }
        if (place.kind === 'internal') {
          const st = await this._statOf(place, from)
          if (st === null || !st.isFile()) continue
          this.io.renameSync(from, to)
        } else {
          await this.cardCall(() => this.io.rename(from, to), { write: true })
        }
        touched.add(shard)
        moved++
        if (++n % MIGRATE_SLICE === 0) await yieldNow()
      }
      if (touched.size > 0 && place.kind === 'internal') {
        for (const shard of touched) fsyncDirSync(shard)
        fsyncDirSync(dir)
      }
    }
    if (moved > 0) log('places: ' + moved + ' file(s) of ' + place.kind + ' memory moved into their shards')
    return moved
  }

  async _statOf (place, file) {
    try {
      return place.kind === 'internal' ? fs.statSync(file) : await this.cardCall(() => this.io.stat(file))
    } catch {
      return null
    }
  }

  async _unlink (place, file) {
    if (place.kind === 'internal') {
      try {
        this.io.unlinkSync(file)
        return true
      } catch {
        return false
      }
    }
    try {
      await this.cardCall(() => this.io.unlink(file), { write: true })
      return true
    } catch {
      return false
    }
  }

  /** Flatten the shards back (an older build reads only flat folders): internal memory. */
  flattenSync () {
    const place = this.internal
    for (const tree of ['library', 'transcodes']) {
      const dir = place.treeDir(tree)
      let shards = []
      try {
        shards = fs.readdirSync(dir).filter((n) => SHARD_RE.test(n))
      } catch {
        continue
      }
      for (const ab of shards) {
        const shard = path.join(dir, ab)
        let names = []
        try { names = fs.readdirSync(shard) } catch { continue }
        for (const name of names) {
          const to = path.join(dir, name)
          if (fs.existsSync(to)) continue
          this.io.renameSync(path.join(shard, name), to)
        }
        try { fs.rmdirSync(shard) } catch {}
      }
      fsyncDirSync(dir)
    }
    place._made.clear()
  }

  // --------------------------------------------------------------- writing

  /**
   * A file staged on `place` becomes <root>/<rel>: one level mkdir of the shard,
   * a rename on that one volume, the shard synced. Never a rename across volumes.
   */
  async commit (staged, place, rel) {
    const [tree, ab, name] = rel.split('/')
    const dir = await this.ensureShard(place, tree, ab)
    const dest = path.join(dir, name)
    if (place.kind === 'internal') {
      if (!isUnder(staged, place.root)) throw codeError('EXDEV', 'a commit across places')
      renameSyncRetry(staged, dest)
      fsyncDirSync(dir)
      return dest
    }
    if (!isUnder(staged, place.root)) throw codeError('EXDEV', 'a commit across places')
    await this.cardCall(() => this.io.rename(staged, dest), { write: true })
    // The new name on the card before anyone counts on it (a moved original's internal
    // copy goes next): the file synced at its new name, which writes its folder entry on
    // a FAT card, then both folders where they can be opened (not on Windows). A rename
    // left in a card's cache when the power goes would leave the bytes under tmp/, where
    // the next start deletes them.
    await this.cardCall(async () => {
      const fh = await this.io.open(dest, 'r+')
      try {
        await fh.sync()
      } finally {
        await fh.close()
      }
    }, { write: true })
    for (const d of new Set([dir, path.dirname(staged)])) {
      await this.cardCall(async () => {
        const fh = await this.io.open(d, 'r')
        try {
          await fh.sync()
        } finally {
          await fh.close()
        }
      }).catch(() => {})
    }
    return dest
  }

  /** The same for a file staged on internal memory: synchronous. */
  commitSync (staged, rel) {
    const place = this.internal
    const [tree, ab, name] = rel.split('/')
    if (!isUnder(staged, place.root)) throw codeError('EXDEV', 'a commit across places')
    const dir = this.ensureShardSync(place, tree, ab)
    const dest = path.join(dir, name)
    renameSyncRetry(staged, dest)
    fsyncDirSync(dir)
    return dest
  }

  /**
   * Remove a file of `place` by moving it into that place's tmp/ and unlinking
   * it there. Internal memory: synchronous, true when gone (as removeAside). A
   * card: a promise of true (gone, or never there while the card is ready), or
   * false (the card not ready, or an error: the caller lists the name in gone).
   */
  remove (place, file) {
    if (place.kind === 'internal') {
      const aside = asidePath(place.tmpDir, file)
      try {
        renameSyncRetry(file, aside)
      } catch (err) {
        return err.code === 'ENOENT' && !fs.existsSync(file)
      }
      unlinkQuiet(aside)
      return true
    }
    return this._removeCard(place, file)
  }

  async _removeCard (place, file) {
    if (!place.ready) return false
    try {
      await this._cardMkdir(place, place.tmpDir)
      const aside = asidePath(place.tmpDir, file)
      await this.cardCall(() => this.io.rename(file, aside), { write: true })
      await this.cardCall(() => this.io.unlink(aside), { write: true }).catch(() => {})
      return true
    } catch (err) {
      if (err.code !== 'ENOENT') return false
      // Missing: gone only if the card is still ours after a look at it.
      const ok = await this._markerOk()
      if (!ok) {
        if (place.state !== 'away') this._toAway(place, 'a file of it is missing and so is its marker')
        return false
      }
      return true
    }
  }

  /** Read `size` bytes of a card file at `pos`, with a short open of its own. */
  async readAt (place, file, pos, size) {
    const read = async () => {
      const fh = await this.io.open(file, 'r')
      try {
        const buf = Buffer.alloc(size)
        const { bytesRead } = await fh.read(buf, 0, size, pos)
        return buf.subarray(0, bytesRead)
      } finally {
        await fh.close()
      }
    }
    return place.kind === 'internal' ? read() : this.cardCall(read)
  }

  /** The SHA-256 of a file (first 24 hex), read in chunks with short opens. */
  async hashOf (place, file, { signal = null } = {}) {
    const hash = crypto.createHash('sha256')
    for (let pos = 0; ; pos += CHUNK) {
      if (signal !== null && signal.aborted) throw codeError('ABORT_ERR', 'stopped')
      const buf = await this.readAt(place, file, pos, CHUNK)
      hash.update(buf)
      if (buf.length < CHUNK) break
    }
    return hash.digest('hex').slice(0, 24)
  }

  /**
   * A copy of a card file in internal tmp/ for a tool that needs a whole file
   * (ffmpeg, fpcalc, the tag reader): { file, done() }. An internal file is its own.
   */
  async localCopy (place, file, { signal = null } = {}) {
    if (place.kind === 'internal') return { file, done: () => {} }
    const tmp = path.join(this.internal.tmpDir, 'in-' + crypto.randomBytes(8).toString('hex') + path.extname(file))
    const fd = fs.openSync(tmp, 'w', 0o600)
    try {
      for (let pos = 0; ; pos += CHUNK) {
        if (signal !== null && signal.aborted) throw codeError('ABORT_ERR', 'stopped')
        const buf = await this.readAt(place, file, pos, CHUNK)
        if (buf.length > 0) fs.writeSync(fd, buf)
        if (buf.length < CHUNK) break
      }
    } catch (err) {
      fs.closeSync(fd)
      unlinkQuiet(tmp)
      throw err
    }
    fs.closeSync(fd)
    return { file: tmp, done: () => unlinkQuiet(tmp) }
  }

  /**
   * The only way a file crosses places: copied into <to>/tmp/mv-<16 hex>.part in
   * chunks (each card call with its own short open, flushed every 4 MiB),
   * hashed while copying, synced, compared with `expectHash`; onto a card it is
   * read back past the page cache and must hash the same. Then `beforeCommit()`
   * (false: drop it) and the commit on `to`. The source is left to the caller.
   * Resolves the destination path; throws on a mismatch, a stop or a lost place.
   */
  async copy (src, from, to, rel, { expectHash = null, size = null, signal = null, beforeCommit = () => true } = {}) {
    if (to.kind === 'card' && !to.ready) throw codeError('ECARDAWAY', 'memory card not ready')
    if (size === null) size = (await this._statOf(from, src) || { size: 0 }).size
    await to.disk.check(size)
    const hold = to.disk.hold(size)
    if (to.kind === 'card') await this._cardMkdir(to, to.tmpDir)
    const part = path.join(to.tmpDir, 'mv-' + crypto.randomBytes(8).toString('hex') + '.part')
    const hash = crypto.createHash('sha256')
    let written = 0
    let fd = null
    const stop = () => { if (signal !== null && signal.aborted) throw codeError('ABORT_ERR', 'stopped') }
    try {
      if (to.kind === 'internal') fd = fs.openSync(part, 'w', 0o600)
      let sinceFlush = 0
      for (let pos = 0; ; pos += CHUNK) {
        stop()
        const buf = from.kind === 'internal' ? await this.readAt(from, src, pos, CHUNK) : await this.readAt(from, src, pos, CHUNK)
        hash.update(buf)
        if (to.kind === 'internal') {
          if (buf.length > 0) fs.writeSync(fd, buf)
        } else if (buf.length > 0) {
          sinceFlush += buf.length
          const flush = sinceFlush >= FLUSH_EVERY
          if (flush) sinceFlush = 0
          await this.cardCall(async () => {
            const fh = await this.io.open(part, written === 0 ? 'w' : 'a')
            try {
              await fh.write(buf, 0, buf.length)
              if (flush) await fh.sync()
            } finally {
              await fh.close()
            }
          }, { write: true })
        }
        written += buf.length
        hold.bytes = Math.max(0, size - written)
        if (buf.length < CHUNK) break
      }
      const got = hash.digest('hex').slice(0, 24)
      if (to.kind === 'internal') {
        fs.fsyncSync(fd)
        fs.closeSync(fd)
        fd = null
      } else {
        if (written === 0) await this.cardCall(async () => { await (await this.io.open(part, 'w')).close() }, { write: true })
        await this.cardCall(async () => {
          const fh = await this.io.open(part, 'r+')
          try { await fh.sync() } finally { await fh.close() }
        }, { write: true })
      }
      if (written !== size) throw codeError('ESIZE', 'the copy has ' + written + ' bytes, ' + size + ' expected')
      if (expectHash !== null && got !== expectHash) throw codeError('EHASH', 'the bytes read are not the track\'s')
      if (to.kind === 'card') {
        // What the card kept, read from the card itself and not from the page cache.
        stop()
        await this.cardCall(() => this.io.dropCache(part))
        const back = await this.hashOf(to, part, { signal })
        if (back !== got) {
          to.bad = true
          logError('memory card ' + to.volume + ': a copy did not read back as written: nothing more goes onto it')
          throw codeError('ECARDBAD', 'the card did not keep the copy')
        }
      }
      stop()
      if (!beforeCommit()) throw codeError('ESTALE_COPY', 'the file changed while it was copied')
      return await this.commit(part, to, rel)
    } catch (err) {
      if (fd !== null) try { fs.closeSync(fd) } catch {}
      if (to.kind === 'internal') unlinkQuiet(part)
      else await this.cardCall(() => this.io.unlink(part), { write: true }).catch(() => {})
      throw err
    } finally {
      hold.release()
    }
  }

  // --------------------------------------------------------------- streams

  /**
   * A readable of bytes start..end of a card file, read in chunks of up to
   * 1 MiB, each with its own short open: a paused response holds nothing on the
   * card. Destroyed at once when the card goes away.
   */
  cardStream (place, file, start, end, owner = null) {
    let pos = start
    const places = this
    const stream = new Readable({
      highWaterMark: CHUNK,
      read () {
        if (pos > end) {
          this.push(null)
          return
        }
        const n = Math.min(CHUNK, end - pos + 1)
        places._lastStreamAt = places.now()
        places.readAt(place, file, pos, n).then((buf) => {
          if (buf.length === 0) {
            this.destroy(codeError('EIO', 'short read'))
            return
          }
          pos += buf.length
          places._lastStreamAt = places.now()
          this.push(buf)
        }, (err) => this.destroy(err))
      }
    })
    // The response it feeds goes with it: the player fails over at once.
    stream.owner = owner
    this._streams.add(stream)
    stream.once('close', () => {
      this._streams.delete(stream)
      this._lastStreamAt = this.now()
    })
    return stream
  }

  /** Is a card stream being sent, or was one in the last 10 s? (the move waits) */
  cardStreamRecently () {
    return this._streams.size > 0 || this.now() - this._lastStreamAt < this.streamQuietMs
  }

  // ------------------------------------------------------------------ room

  /**
   * The place for a new file of `bytes` (`original`, `transcode`, `extraction`):
   * originals and extractions on the card when it is in use and has room, else
   * internal; transcodes internal first, then the card. null: no room anywhere.
   */
  async forNew (kind, bytes) {
    this.maybeRecheck()
    const card = this.card
    const cardUsable = card !== null && card.ready && !card.leaving && !card.bad && !card.invalid
    const order = kind === 'transcode' ? [this.internal, cardUsable ? card : null] : [cardUsable ? card : null, this.internal]
    for (const place of order) {
      if (place === null) continue
      if (await this.hasRoom(place, bytes)) return place
    }
    return null
  }

  async hasRoom (place, bytes) {
    const { free, floor } = await place.disk.state()
    return free - place.disk.reserved() - bytes >= floor
  }

  // ----------------------------------------------------------------- health

  /** The places as health shows them. */
  async health ({ tracks = null, awayTracks = null } = {}) {
    this.maybeRecheck()
    const out = []
    const i = await this.internal.disk.state()
    out.push({ kind: 'internal', freeBytes: finite(i.free), totalBytes: i.total, floorBytes: i.floor })
    const card = this.card
    if (card !== null) {
      const c = { kind: 'card', state: card.invalid ? 'away' : card.state }
      if (card.readable) {
        // A card that hangs never holds health: its sizes are left out then.
        const s = await Promise.race([card.disk.state(), new Promise((resolve) => setTimeout(resolve, HEALTH_WAIT_MS, null).unref())])
        if (s !== null) {
          c.freeBytes = finite(s.free)
          c.totalBytes = s.total
          c.floorBytes = s.floor
        }
      }
      if (tracks !== null) c.tracks = tracks
      if (awayTracks !== null) c.awayTracks = awayTracks
      out.push(c)
    }
    return out
  }

  // -------------------------------------------------------------- discovery

  /**
   * The cards under <cards> (only to offer them): { volume, freeBytes,
   * totalBytes, usable, why, appFolder, root, folder }. Nothing is written.
   */
  async discover () {
    if (this.cardsDir === null) return []
    let names
    try {
      names = await this.io.readdir(this.cardsDir)
    } catch {
      return []
    }
    let cardsDev
    try {
      cardsDev = await this.io.devOf(this.cardsDir)
    } catch {
      return []
    }
    const found = []
    for (const volume of names.sort()) {
      if (!VOLUME_RE.test(volume) || volume === 'emulated' || volume === 'self') continue
      const vdir = path.join(this.cardsDir, volume)
      try {
        if (await this.io.devOf(vdir) === cardsDev) continue // not a mounted volume
      } catch {
        continue
      }
      const entry = { volume, freeBytes: null, totalBytes: null, usable: false, why: 'no_access', appFolder: false, folder: null, root: null }
      try {
        const st = await (this._statfs ? this._statfs(vdir) : this.io.statfs(vdir))
        entry.freeBytes = st.bavail * st.bsize
        entry.totalBytes = st.blocks * st.bsize
      } catch {}
      let folder = null
      if (await this._writable(vdir)) {
        folder = ROOT_FOLDER
      } else {
        const app = 'Android/data/' + packageName() + '/files'
        if (await this._writable(path.join(vdir, ...app.split('/')))) {
          folder = app + '/' + ROOT_FOLDER
          entry.appFolder = true
        }
      }
      if (folder !== null) {
        entry.folder = folder
        entry.root = path.join(vdir, ...folder.split('/'))
        entry.usable = true
        entry.why = null
        const marker = await this._readMarker(entry.root)
        if (marker !== null && !this._ours(marker) && !(this.card !== null && marker.id === this.card.id)) {
          entry.usable = false
          entry.why = 'other_source'
        }
      }
      found.push(entry)
    }
    return found
  }

  async _writable (dir) {
    try {
      await this.io.access(dir, fs.constants.W_OK)
      return true
    } catch {
      return false
    }
  }

  async _readMarker (root) {
    try {
      const m = JSON.parse(String(await this.io.readFile(path.join(root, MARKER))))
      return m && m.mpfy === 'place' && typeof m.id === 'string' ? m : null
    } catch {
      return null
    }
  }

  // A marker this source wrote (a card it used and forgot), told by the marker's
  // `source` (the id alone decides only at start and at a return).
  _ours (marker) {
    return marker.source === this._sourceTag()
  }

  _sourceTag () {
    const key = this.serverPublicKey()
    return typeof key === 'string' && key !== '' ? crypto.createHash('sha256').update(key).digest('hex').slice(0, 16) : null
  }

  // -------------------------------------------------------------- choosing

  /**
   * The owner chooses a found card: its folder made (one level), the marker
   * written (or this source's reused), a write probed, then `card` in
   * source.json. Throws card_in_use, card_gone, card_no_access, card_taken,
   * card_read_only. Resolves the new card place (ready).
   */
  async choose (volume) {
    if (this.card !== null) throw apiError('card_in_use')
    const found = (await this.discover()).find((c) => c.volume === volume)
    if (!found) throw apiError('card_gone')
    if (found.why === 'other_source') throw apiError('card_taken')
    if (!found.usable) throw apiError('card_no_access')
    const root = found.root
    const calls = this.io
    const wrap = async (fn) => {
      try {
        return await fn()
      } catch (err) {
        if (err.code === 'EROFS') throw apiError('card_read_only')
        if (err.code === 'EACCES' || err.code === 'EPERM') throw apiError('card_no_access')
        if (err.code === 'ENOENT') throw apiError('card_gone')
        throw err
      }
    }
    await wrap(async () => {
      try {
        await calls.mkdir(root)
      } catch (err) {
        if (err.code !== 'EEXIST') throw err
      }
    })
    let marker = await this._readMarker(root)
    const tag = this._sourceTag()
    if (marker !== null && !this._ours(marker)) throw apiError('card_taken')
    // MediaStore must not index the originals.
    if (marker === null || !(await exists(calls, path.join(root, NOMEDIA)))) {
      await wrap(() => writeFileOn(calls, path.join(root, NOMEDIA), Buffer.alloc(0)))
    }
    if (marker === null) {
      marker = { mpfy: 'place', schema: 1, id: crypto.randomBytes(16).toString('hex'), source: tag, createdAt: this.now() }
      await wrap(() => writeAtomicOn(calls, root, MARKER, Buffer.from(JSON.stringify(marker))))
    }
    await wrap(async () => {
      try {
        await calls.mkdir(path.join(root, 'tmp'))
      } catch (err) {
        if (err.code !== 'EEXIST') throw err
      }
      const probe = path.join(root, 'tmp', 'probe-' + crypto.randomBytes(4).toString('hex'))
      await writeFileOn(calls, probe, Buffer.alloc(0))
      await calls.unlink(probe)
    })
    const setting = { volume, folder: found.folder, id: marker.id, chosenAt: this.now(), leaving: false }
    if (this.source !== null) this.source.update({ card: setting })
    this.setting = setting
    const card = this._newCard(setting)
    card.state = 'ready'
    card.listed = 'ready'
    card._made.add(card.tmpDir)
    this.card = card
    this._watch()
    this._lastCheck = this.now()
    this.emit('chosen', card)
    return card
  }

  /** The owner stops using the card: the music goes back (the move job), then card: null. */
  leave () {
    const card = this.card
    if (card === null || card.invalid) throw apiError('card_gone')
    card.leaving = true
    if (this.source !== null) this.source.update({ card: { ...this.source.data.card, leaving: true } })
    this.emit('leaving', card)
  }

  /**
   * Nothing of ours is left on the card: its empty folders, .nomedia, the
   * marker and the root go, then card: null.
   */
  async finishLeave () {
    const card = this.card
    if (card === null || !card.ready) return false
    for (const tree of ['library', 'transcodes']) {
      const dir = card.treeDir(tree)
      let shards = []
      try {
        shards = await this.cardCall(() => this.io.readdir(dir))
      } catch {}
      for (const ab of shards) await this.cardCall(() => this.io.rmdir(path.join(dir, ab)), { write: true }).catch(() => {})
      await this.cardCall(() => this.io.rmdir(dir), { write: true }).catch(() => {})
    }
    for (const dir of [card.tmpDir, card.uploadsDir, card.pendingDir]) {
      let names = []
      try { names = await this.cardCall(() => this.io.readdir(dir)) } catch {}
      for (const n of names) await this.cardCall(() => this.io.unlink(path.join(dir, n)), { write: true }).catch(() => {})
      await this.cardCall(() => this.io.rmdir(dir), { write: true }).catch(() => {})
    }
    await this.cardCall(() => this.io.unlink(path.join(card.root, NOMEDIA)), { write: true }).catch(() => {})
    await this.cardCall(() => this.io.unlink(path.join(card.root, MARKER)), { write: true }).catch(() => {})
    await this.cardCall(() => this.io.rmdir(card.root), { write: true }).catch(() => {})
    this._drop()
    return true
  }

  /** The owner forgets the card: card: null, nothing written on the card. */
  forget () {
    if (this.card === null) throw apiError('card_gone')
    this._drop()
  }

  _drop () {
    const card = this.card
    if (card !== null) {
      this._clear(card._listedTimer)
      card._listedTimer = null
    }
    if (this.source !== null) this.source.update({ card: null })
    this.setting = null
    this.card = null
    this.emit('dropped', card)
  }

  close () {
    this._closed = true
    for (const t of this._timers) clearTimeout(t)
    this._timers.clear()
    if (this._watcher !== null) try { this._watcher.close() } catch {}
    this._watcher = null
    this.gate.failWaiting(codeError('ECARDAWAY', 'closed'))
  }
}

/** Is this error the card going away (not a failure of the work itself)? */
export function isCardAway (err, place = null) {
  if (place !== null && place.kind === 'card' && !place.ready) return true
  return !!err && (err.code === 'ECARDAWAY' || err.code === 'ETIMEDOUT')
}

function isUnder (file, root) {
  const rel = path.relative(root, path.resolve(file))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function finite (n) {
  return Number.isFinite(n) ? n : null
}

function envBytes (name) {
  const v = process.env[name]
  if (v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : null
}

async function exists (io, file) {
  try {
    await io.stat(file)
    return true
  } catch {
    return false
  }
}

async function writeFileOn (io, file, buf) {
  const fh = await io.open(file, 'w', 0o600)
  try {
    if (buf.length > 0) await fh.write(buf, 0, buf.length)
    await fh.sync()
  } finally {
    await fh.close()
  }
}

// A small file written atomically: a temporary file, fsync, rename, fsync of the folder.
async function writeAtomicOn (io, dir, name, buf) {
  const tmp = path.join(dir, name + '.tmp')
  await writeFileOn(io, tmp, buf)
  await io.rename(tmp, path.join(dir, name))
  try {
    const fh = await io.open(dir, 'r')
    try { await fh.sync() } finally { await fh.close() }
  } catch {}
}

function yieldNow () {
  return new Promise((resolve) => setImmediate(resolve))
}
