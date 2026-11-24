// The shared library of a source (tracks, track and album custom covers) and
// its persistence in library.log: one line appended per change, never a whole
// rewrite (vjournal.mjs is the file layer under it). Its lines carry their
// versions, so the log on disk is also the index of what changed since any
// version a client holds:
//   {"mpfy":"library-log","schema":1,"from":{...}}  the header (`from`: the db.json it knows)
//   {"e":"<16 hex>","v":E}                          an epoch begins; its first change takes E + 1
//   [v,"t:<id>",{stored track},code]                the track as stored, its derived code
//   [v,"t:<id>"]                                    the track is gone
//   [v,"d:<id>",code]                               its derived code moved
//   [v,"c:track:<id>",{small,large}], [v,"c:album:<id>",...]  a shared custom cover (no value: cleared)
//   [v,"g",[names]]  the files that must go   [v,"s"]  the source's name or switches
//   [v,"z"]  a reset (no delta crosses it)       [v,"x",{...}]  unknown fields of db.json
//   [v,"p",{"card":"<id>"}], [v,"p"]  a memory card holds music (its marker's id), or none
//   {"ep":[...]}, {"h":H}, {"S":Vs} ... {"E":Ve}  a compacted file: epochs, horizon, the rewritten part
//   {"xp":{size,mtimeMs}}                           export-compat wrote db.json with this stat
// The derived code: bit 0 low ready, 1 normal ready, 2 high ready, 3 synced
// lyrics, 4 plain lyrics, 5 away (the original is on a memory card that is not
// here now). A key's last line wins.
//
// Changes come in batches: the changes of one request, one sweep, the start, or
// one call of derivedChanged() share one version and go out in one checked write
// (a version moves by one per batch, never ahead of the clock by bulk work). A
// write that fails (a full disk) is cut back: a batch small enough to be undone
// changes nothing and its request is answered 507; a bigger one (the start, a
// sweep, a profile's tracks) stays in memory and is written again, with what
// came since, under a new epoch, so no client keeps a version the disk never had.
// Nothing changes a stored track in place: every change builds a new object and
// stores it through _put() (tests freeze the stored tracks to prove it).
//
// db.json (schema 3) is read once to make the log and never written again: an
// older MPfy started on this data dir still finds it. A db.json changed after the
// log was made (an older MPfy ran meanwhile) makes the log step aside as
// library.log.replaced-<ms> and db.json is read again.
//
// Track files live in places (places.mjs): internal memory and at most one
// memory card, each in library/<ab>/<name>. On start the state is reconciled
// with them: files the log does not know (a crash right after an upload) are
// adopted; entries whose file is gone are dropped, but only when every place a
// card may be in was listed completely (a card away, or one the log names and
// source.json lost, keeps its tracks, away); when one id has several files (a
// crash during a replacement or a move) the one the log names, on the place its
// kind prefers, stays. Adopted files reorder the library by date, and the log is
// then rewritten in that order before anything is served. A card coming back is
// reconciled the same way while the source runs; what it adopts goes at the end.
//
// A track's file never goes by a plain unlink or a rename over it: it is moved
// aside into tmp/ first (Windows keeps the name of a file someone reads until it
// is closed, and refuses to rename over it). A replacement cut between its two
// renames finds the file the log names in tmp/ at the next start, and puts it
// back. A file that must go while a program still holds it (a deleted track's,
// or one replaced by a file of another format) stays listed (`gone`) until it can
// go: never adopted again meanwhile.
//
// The stored tracks are kept small: the fingerprint signature lives in an arena
// outside the heap (256 bytes per slot; the stored `fp` reads it back on demand),
// repeated strings are interned, `fileHash` shares the id's string, and the small
// arrays are frozen and shared by content. Each track has a slot (a small integer
// under a Symbol, never serialized) that the change index keeps its version, its
// place in the order and its derived code by.
//
// Each person's playlists, likes and recents live in users/ (users.mjs). Stored
// only, never returned: who uploaded a track (`uploaders`), the tracks they said
// are other songs (`notSame`), `fpState`, `qualityV` (the version of the quality
// analysis it had), and for the details from the network `tagless` (fields its
// file has no tag for), `edited` (fields a person changed), `editedUnknown` (a
// track from before both) and `lookup` (the last lookup).

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { HttpError } from './errors.mjs'
import {
  isTrackId, isCoverId, isProfileId, AUDIO_FORMATS, LIBRARY_FILE_RE, COVER_FILE_RE, COVER_SIZED_RE,
  COVER_EXTS, COVER_SIZES, trackFileName, isAlbumId
} from './ids.mjs'
import { readAudio, saveCover, buildTrack, sniffAudio, HEAD_BYTES, UNKNOWN_ARTIST, UNKNOWN_ALBUM, TAGLESS_FIELDS } from './media.mjs'
import { CODECS, EQUIV_KBPS, codecOf, scoreOf, validCutoff, unanalysed } from './quality.mjs'
import {
  ensureDir, renameSyncRetry, unlinkQuiet, removeTree, asidePath, removeAside, isBusy, log, logError
} from './util.mjs'
import {
  LogFile, replayLog, Epochs, newEpochId, isEpochId, ZERO_EPOCH, DEFAULT_IO, writeAllSync, fsyncAsync, renameRetry, yieldNow
} from './vjournal.mjs'
import { Places, CODE } from './places.mjs'
import { readDbJson, hashFile, HASH_RE } from './dbjson.mjs'
import { splitGenres } from '../web/js/genres.js'
import { validLoud } from '../web/js/loudness.js'

export const DB_SCHEMA = 3
export const LOG_SCHEMA = 1
/** Track tombstones kept for deltas (older ones raise the horizon). */
export const KEEP_TOMBSTONES = 10000
/** Changes kept in the ring for recent deltas (older ones need one scan). */
export const RING_SIZE = 65536

const GONE_RETRY_MS = 10 * 1000 // a file in `gone` that a program still holds: tried again this often
const RETRY_MS = 5000 // changes a failed write left in memory: written again this often
// tmp/was-<fileHash>-<8 hex>-<file name>: a track's file a replacement moved aside.
const SET_ASIDE_RE = /^was-([0-9a-f]{24})-[0-9a-f]{8}-(.+)$/
const SIG_BYTES = 256
const UNDO_LIMIT = 1000 // a batch touching more tracks is not undone when its write fails
const COMPACT_MIN_DEAD = 1024 * 1024
const SLICE_BYTES = 256 * 1024
const KEPT_LEFT = 64 * 1024
const CHUNK_BYTES = 1024 * 1024
const TRACK_SLICE = 250
const SLOT = Symbol('slot')
const SIG_SLOT = Symbol('sigSlot')
const SIG_GEN = Symbol('sigGen')
const EMPTY = Object.freeze([])
const ABORTED = new Error('compaction given up')

const NO_QUALITIES = Object.freeze({ low: false, normal: false, high: false })
const AWAY = 32 // bit 5 of the derived code
const LEVEL_BITS = 7
// What a client sees of a track (plus qualities, mine and others).
const PUBLIC_FIELDS = [
  'id', 'title', 'artist', 'album', 'albumArtist', 'trackNo', 'discNo', 'year', 'duration', 'format', 'mime',
  'size', 'bitrate', 'lossless', 'addedAt', 'coverId', 'fileHash', 'codec', 'sampleRate', 'bitDepth',
  'fakeLossless', 'equivKbps', 'cutoffHz', 'score', 'fp'
]
// Fields a person edits (PATCH /api/tracks/:id).
export const EDITABLE_FIELDS = ['title', 'artist', 'album', 'albumArtist']
const LOOKUP_STATES = ['applied', 'nothing', 'ambiguous', 'failed']
// The track fields a duplicate or a replacement fills, with their tagless names.
const FILL_FIELDS = { title: 'title', artist: 'artist', album: 'album', albumArtist: 'albumArtist', trackNo: 'trackNo', discNo: 'discNo', year: 'year', coverId: 'cover' }
const SHARED_KINDS = { track: isTrackId, album: isAlbumId }

export function isUploader (v) {
  return v === 'owner' || isProfileId(v)
}

// The changes of one batch: what each key needs written, and how to undo them.
function newBatch (undoable = true) {
  return {
    undoable,
    tracks: new Map(), // id -> { existed, t, d, del, before }
    covers: new Set(), // 'track:<id>', 'album:<id>'
    g: false,
    s: false,
    z: false,
    x: false,
    p: false,
    allocated: [], // slots taken by tracks new in this batch
    freed: [], // slots of tracks deleted in this batch (freed once written)
    savedCovers: new Map(), // kind -> the entries before the batch
    savedGone: null,
    after: [], // run once the batch is written
    onUndo: [] // run when it is undone
  }
}

function isEmptyBatch (b) {
  return b.tracks.size === 0 && b.covers.size === 0 && !b.g && !b.s && !b.z && !b.x && !b.p
}

export class Library {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir
   * @param {() => Set<string>} [opts.extraCoverIds]  covers used elsewhere (playlist covers)
   * @param {number} [opts.goneRetryMs]  how often a held file in `gone` is tried again
   * @param {boolean} [opts.holdStart=false]  open() leaves the start's changes open: the
   *   caller ends them with finishStart() once the derived state (transcodes, lyrics) is known
   * @param {boolean} [opts.freezeTracks]  the stored tracks are frozen (tests)
   * @param {object} [opts.io]  the file system calls of the log (tests)
   * @param {number} [opts.syncEveryMs]  the least time between two syncs of the log
   * @param {import('./places.mjs').Places} [opts.places]  where the files are (default: internal memory only)
   */
  constructor ({
    dataDir, extraCoverIds = () => new Set(), goneRetryMs = GONE_RETRY_MS, holdStart = false,
    freezeTracks = process.env.MPFY_FREEZE_TRACKS === '1', io = DEFAULT_IO, syncEveryMs, places = null
  }) {
    this.dataDir = path.resolve(dataDir)
    this.libraryDir = path.join(this.dataDir, 'library')
    this.coversDir = path.join(this.dataDir, 'covers')
    this.transcodesDir = path.join(this.dataDir, 'transcodes')
    this.tmpDir = path.join(this.dataDir, 'tmp')
    this.dbFile = path.join(this.dataDir, 'db.json')
    this.logFile = path.join(this.dataDir, 'library.log')
    this.extraCoverIds = extraCoverIds
    this.goneRetryMs = goneRetryMs
    this.holdStart = holdStart
    this.freezeTracks = freezeTracks
    this.io = io
    this.syncEveryMs = syncEveryMs
    // Called with a track id when another file of the track changed its album
    // over the one the network filled: it is looked up again (details.mjs).
    this.onStaleLookup = () => {}
    // Which Opus versions of a track are ready (set by the transcoder).
    this.qualitiesOf = () => NO_QUALITIES
    // "synced", "plain" or null: the lyrics a track shows (set by lyrics.mjs).
    this.lyricsOf = () => null
    // Called with a track id (and how: edit, set, file, fill) after its stored
    // fields changed, so what depends on its title, artist, album or duration follows.
    this.onTrackChange = () => {}
    // Called with a slot that no track holds any more (the fingerprint index).
    this.onSlotFree = () => {}
    // The memory card's transcodes leave (it stayed away), and come back with it
    // (`ids`: the tracks whose original came back): set by app.mjs for the jobs.
    this.onCardGone = () => {}
    this.onCardBack = async (ids) => {}
    // Tracks that left without a deletion (a forgotten card): their transcodes go.
    this.onDropped = (tracks) => {}

    this.places = places || new Places({ dataDir: this.dataDir })
    this.places.on('state', (place, from, to) => {
      if (place.kind === 'card' && to === 'ready' && from !== 'readonly') this._cardReturn().catch((err) => logError('library: the memory card back, not read: ' + err.message))
    })
    this.places.on('listed', (place, from, to) => {
      if (place.kind === 'card' && to === 'away') this._cardListedAway()
    })

    // The stored fingerprint signature: d and b on the object, the bytes in the
    // arena at its slot, read back while that slot still holds them.
    const lib = this
    this._Sig = class StoredSignature {
      constructor (d, b, slot, gen) {
        this.d = d
        this.b = b
        this[SIG_SLOT] = slot
        this[SIG_GEN] = gen
      }

      get s () {
        return lib._sigString(this[SIG_SLOT], this[SIG_GEN])
      }

      toJSON () {
        return { d: this.d, b: this.b, s: this.s }
      }
    }

    this.writes = 0 // batches written (used by tests)
    this.compactions = 0
    this._log = null
    this._batch = null
    this._depth = 0
    this._holding = false
    this._recording = true
    this._reordered = false
    this._unwritten = null // the changes a failed write left in memory
    this._retryTimer = null
    this._goneTimer = null
    this._kept = null // lines appended while a compaction runs
    this._compacting = null
    this._closed = false
    this._opening = null
    this._returning = null
    this._heldNames = 0 // names in gone a program holds on internal memory (retried by a timer)
    this._internalComplete = true
    this._initState()
  }

  _initState () {
    this.version = 0
    this.epoch = ZERO_EPOCH
    this.tracks = new Map() // id -> track, in insertion (upload) order
    // Names in library/ of files that must go but could not yet.
    this._gone = new Set()
    // Shared custom covers: kind -> Map(id -> { small, large })
    this.customCovers = { track: new Map(), album: new Map() }
    // What an older db.json held for the owner (playlists, likes, recents,
    // playlist covers): the migration moves it into users/.
    this.legacyUserData = null
    this._extra = {}
    this._dbVersion = 0
    this._from = null
    this._epochs = new Epochs()
    this._horizon = 0
    this._diskV = 0 // the version of the last line on disk
    this._epochOpen = false // this run wrote its epoch line
    // By slot.
    this._cap = 0
    this._bySlot = []
    this._free = []
    this._cv = new Float64Array(0) // the version of the track's last t: or d: line
    this._seq = new Float64Array(0) // its place in the Map order
    this._code = new Uint8Array(0)
    this._place = new Uint8Array(0) // where its original is: 0 unknown, 1 internal, 2 card
    this._tlen = new Uint32Array(0) // the bytes of its current t: line
    this._sigLen = new Uint16Array(0)
    this._sigGen = new Uint32Array(0)
    this._arena = Buffer.alloc(0)
    this._seqN = 0
    this._liveBytes = 0
    // The last RING_SIZE changes as (version, slot), oldest first from the head.
    this._ringV = new Float64Array(RING_SIZE)
    this._ringS = new Int32Array(RING_SIZE)
    this._ringHead = 0
    this._ringCount = 0
    this._ringFloor = 0 // every change newer than this is in the ring
    // The newest KEEP_TOMBSTONES removed tracks.
    this._tombIds = Buffer.alloc(KEEP_TOMBSTONES * 12)
    this._tombV = new Float64Array(KEEP_TOMBSTONES)
    this._tombHead = 0
    this._tombCount = 0
    this._coverV = new Map() // 'kind:id' -> version of the cover's last line
    this._coverTombs = new Map() // 'kind:id' -> version it was cleared
    this._gv = 0
    this._sv = 0
    this._xv = 0
    this._pv = 0
    this._cardId = null // the memory card the log says holds music
    this._strings = new Map()
    this._arrays = new Map()
  }

  // ---------------------------------------------------------------- loading

  /**
   * Read library.log (or make it from db.json) and reconcile it with the files.
   * @returns {Promise<{status: 'ok'|'missing'|'corrupt', corruptFile: string|null, adopted: number, dropped: number}>}
   */
  open () {
    if (this._opening === null) this._opening = this._open()
    return this._opening
  }

  async _open () {
    ensureDir(this.dataDir)
    ensureDir(this.libraryDir)
    ensureDir(this.coversDir)
    ensureDir(this.transcodesDir)
    ensureDir(this.tmpDir)
    // The places: internal memory, the card when it shows; today's flat folders
    // move into their shards before anything is read.
    await this.places.open()
    await this.places.migrateFlat(this.places.internal)
    if (this.places.card !== null && this.places.card.ready) await this.places.migrateFlat(this.places.card)

    const result = { status: 'ok', corruptFile: null, adopted: 0, dropped: 0 }
    this._recording = false
    // A rewrite cut by a crash: the log it was to replace is whole.
    unlinkQuiet(this.logFile + '.tmp')
    let fromLog = false
    const replayed = await this._replayLog()
    if (replayed === 'corrupt') {
      const aside = this.logFile + '.corrupt-' + Date.now()
      renameSyncRetry(this.logFile, aside)
      logError('library.log has no valid header, moved to ' + path.basename(aside))
      this._initState()
    } else if (replayed === 'ok') {
      const st = statOrNull(this.dbFile)
      if (st !== null && !sameStat(st, this._from) && !(await this._sameDb(st))) {
        // An older MPfy wrote db.json after this log was made: what it holds is
        // newer. The log is kept aside (never deleted) and db.json read again.
        if (this._log !== null) this._log.close()
        this._log = null
        const aside = this.logFile + '.replaced-' + Date.now()
        renameSyncRetry(this.logFile, aside)
        logError('db.json changed after library.log was made (an older MPfy ran): the log is kept as ' + path.basename(aside) + ', db.json read again')
        this._initState()
      } else {
        fromLog = true
      }
    }

    if (!fromLog) {
      const st = statOrNull(this.dbFile)
      if (st === null) {
        result.status = 'missing'
      } else {
        try {
          const hash = await this._loadDb()
          this._from = { size: st.size, mtimeMs: st.mtimeMs, hash }
        } catch (err) {
          // A file that cannot be read is not a corrupt one: the start fails, nothing moves.
          if (!err.corrupt) throw err
          result.status = 'corrupt'
          result.corruptFile = this.dbFile + '.corrupt-' + Date.now()
          renameSyncRetry(this.dbFile, result.corruptFile)
          this._initState()
          logError('db.json is corrupt (' + err.message + '), moved to ' + path.basename(result.corruptFile) + ', rescanning library/')
        }
      }
    }

    // After the log is read: it says which file set aside in tmp/ goes back.
    this._cleanTmp()
    // The start is one batch. Without a log on disk the whole state is written at
    // its end, so nothing needs recording until then.
    this._holding = true
    this._batch = newBatch(false)
    this._depth = 1
    this._recording = fromLog
    // The log remembers which card holds music, so a lost source.json never
    // makes a start drop the card's tracks.
    const chosen = this.places.card
    if (chosen !== null && !chosen.invalid && chosen.id !== null && this._cardId !== chosen.id) {
      this._cardId = chosen.id
      this._mark('p')
    }
    const rec = await this._reconcile()
    result.adopted = rec.adopted
    result.dropped = rec.dropped
    if (rec.adopted || rec.dropped) log('library: adopted ' + rec.adopted + ' file(s), dropped ' + rec.dropped + ' missing')
    if (!this.holdStart) await this.finishStart()
    return result
  }

  /**
   * The end of the start, once the transcodes and the lyrics are known: every
   * track whose derived code moved while the source was stopped gets its line,
   * and the start's changes are written in one batch (opening this run's epoch).
   * Without a log, the log is made from the whole state. After an adoption the
   * log is rewritten in the new order before this resolves.
   */
  async finishStart () {
    if (!this._holding) return
    if (this._log === null) {
      await this._createLog()
    } else {
      for (const t of this.tracks.values()) {
        if (this._codeOf(t) !== this._code[t[SLOT]]) this._markDerived(t.id, t)
      }
      const reordered = this._reordered
      this._reordered = false
      this._endHold()
      if (reordered) {
        if (this._unwritten === null) await this.compact()
        else logError('library.log: the new order after an adoption is not written yet (the disk refused the start)')
      } else {
        this._maybeCompact(true)
      }
    }
    this._sweepLater()
    if (this.places.card !== null && this.places.card.ready) this._sweepGoneCard().catch(() => {})
  }

  _endHold () {
    this._holding = false
    this._depth = 0
    const b = this._batch
    this._batch = null
    this._recording = true
    this._commit(b)
  }

  // db.json, never held whole (dbjson.mjs): its tracks stored one at a time as they
  // are read. A wrong top-level shape throws (treated as corrupt); single bad entries
  // are skipped. Resolves with the hash of its bytes.
  async _loadDb () {
    this._initState()
    // The schema comes before the tracks in every db.json of schema 3; when it does
    // not, the tracks wait for the end of the file to know it.
    let legacy = null
    let held = null
    const r = await readDbJson(this.dbFile, (t, head) => {
      if (legacy === null) {
        if ('schema' in head) legacy = schemaOf(head) < DB_SCHEMA
        else {
          legacy = false
          held = []
        }
      }
      if (held !== null) held.push(t)
      else if (t && isTrackId(t.id) && AUDIO_FORMATS[t.format]) this._put(t, legacy)
    })
    if (!r.tracks) throw Object.assign(new Error('tracks is not an array'), { corrupt: true })
    const data = r.head
    legacy = schemaOf(data) < DB_SCHEMA
    if (held !== null) {
      for (const t of held) if (t && isTrackId(t.id) && AUDIO_FORMATS[t.format]) this._put(t, legacy)
    }
    this._dbVersion = Number.isSafeInteger(data.version) && data.version > 0 ? data.version : 1
    const { schema: _s, version: _v, playlists, likes, recents, covers, gone, ...extra } = data
    this._extra = legacy ? {} : extra
    if (Array.isArray(gone)) for (const name of gone) if (typeof name === 'string' && LIBRARY_FILE_RE.test(name)) this._gone.add(name)
    const c = covers && typeof covers === 'object' ? covers : {}
    for (const kind of Object.keys(SHARED_KINDS)) {
      const entries = c[kind] && typeof c[kind] === 'object' ? c[kind] : {}
      for (const [id, entry] of Object.entries(entries)) {
        if (!SHARED_KINDS[kind](id) || !entry || typeof entry !== 'object') continue
        const small = isCoverId(entry.small) ? entry.small : null
        const large = isCoverId(entry.large) ? entry.large : null
        if (small !== null || large !== null) this._coverPut(kind, id, { small, large })
      }
    }
    if (legacy) {
      this.legacyUserData = {
        playlists: Array.isArray(playlists) ? playlists : [],
        likes: Array.isArray(likes) ? likes : [],
        recents: Array.isArray(recents) ? recents : [],
        covers: { playlist: c.playlist && typeof c.playlist === 'object' ? c.playlist : {} }
      }
    }
    return r.hash
  }

  // db.json's time changed since the log knew it, but not its bytes (a copy that did
  // not keep the times): the same file. The log then knows its new stat.
  async _sameDb (st) {
    const from = this._from
    if (from === null || from.hash === undefined || from.size !== st.size) return false
    if (await hashFile(this.dbFile) !== from.hash) return false
    this._from = { size: st.size, mtimeMs: st.mtimeMs, hash: from.hash }
    try {
      this._log.append(Buffer.from(JSON.stringify({ xp: this._from }) + '\n'))
    } catch {}
    log('db.json has the bytes library.log knows, only its time changed: the log stays the truth')
    return true
  }

  async _reconcile () {
    const places = this.places
    const internal = places.internal
    const card = places.card
    // Files of deleted tracks that could not go then go now, and are never adopted.
    const goneBefore = this._gone.size
    this._sweepGone({ retry: true })

    // id -> [{ name, place }], only names that match our own pattern.
    const files = new Map()
    const listed = [internal]
    if (card !== null && card.readable) listed.push(card)
    let complete = true
    for (const place of listed) {
      const r = await this._listInto(place, files)
      if (!r.complete) complete = false
      if (place === internal) this._internalComplete = r.complete
    }
    // A card that could not be listed (away, not mounted yet, malformed in
    // source.json), or one the log names and source.json does not hold: its
    // tracks may be there, so none is dropped.
    if (card !== null && !listed.includes(card)) complete = false
    if (this._cardId !== null && (card === null || card.id !== this._cardId)) {
      complete = false
      if (card === null) logError('library: library.log says a memory card holds music and source.json names none: no track is dropped ("card use" with that card brings them back)')
    }

    // A track whose file is gone leaves the library, but NOT the user data: the
    // same id may be a track of another source.
    let dropped = 0
    const sized = []
    let n = 0
    for (const [id, track] of [...this.tracks]) {
      if (++n % TRACK_SLICE === 0) await yieldNow()
      const copies = files.get(id) || []
      files.delete(id)
      // The usual case, decided at once: its one file, under its own name.
      if (copies.length === 1 && copies[0].name === trackFileName(track)) {
        this._place[track[SLOT]] = copies[0].place.code
        sized.push({ track, place: copies[0].place })
        continue
      }
      const kept = await this._keepOne(track, copies)
      if (kept === null) {
        if (complete) {
          this._delete(id)
          dropped++
        } else {
          this._place[track[SLOT]] = CODE.unknown
        }
        continue
      }
      this._place[track[SLOT]] = kept.place.code
      if (kept.refresh) sized.push({ track, st: null })
      else sized.push({ track, place: kept.place })
    }
    // Cut between the rename and the write of a same-format replacement: the
    // file is not the one the log describes (its size, read in batches).
    const refreshed = await this._refreshChanged(sized)

    const adopted = await this._adopt(files, { atStart: true })
    // Adopted files take their place by date, as if they had been uploaded then.
    if (adopted > 0) this._reorderByDate()

    // Custom covers whose image is gone (deleted by hand): forget them.
    let lostCovers = 0
    for (const [kind, map] of Object.entries(this.customCovers)) {
      for (const [id, entry] of [...map]) {
        const next = { small: entry.small, large: entry.large }
        for (const size of COVER_SIZES) {
          if (next[size] !== null && this._coverOriginal(next[size]) === null) {
            next[size] = null
            lostCovers++
          }
        }
        if (next.small === entry.small && next.large === entry.large) continue
        if (next.small === null && next.large === null) this._coverDelete(kind, id)
        else this._coverPut(kind, id, next)
      }
    }

    this._cleanCovers()
    const goneChanged = this._gone.size !== goneBefore
    return { dropped, adopted, changed: dropped > 0 || adopted > 0 || lostCovers > 0 || refreshed > 0 || goneChanged }
  }

  // The track files of `place` into `files` (id -> [{ name, place }]); names in
  // gone are left out. Resolves { complete }.
  _listInto (place, files) {
    return this.places.list(place, 'library', (names) => {
      for (const name of names) {
        const m = LIBRARY_FILE_RE.exec(name)
        if (m === null || this._gone.has(name)) continue
        let list = files.get(m[1])
        if (list === undefined) files.set(m[1], list = [])
        list.push({ name, place })
      }
    })
  }

  /**
   * Of the files found for a known track, the one that stays: { place, refresh }
   * or null when none is its file. Files of other names under its id (a
   * replacement cut) go. Two copies of its file (a move cut after its rename, a
   * file put back while the card was away): the one whose size, then whose
   * bytes, are the track's, on the place its kind prefers; the others go. When
   * none is, the preferred one stays and is read again (refresh).
   */
  async _keepOne (track, copies) {
    if (copies.length === 0) return null
    const own = trackFileName(track)
    const mine = []
    for (const c of copies) {
      if (c.name === own) mine.push(c)
      else await this._removeCopy(c)
    }
    if (mine.length === 0) return null
    if (mine.length === 1) return { place: mine[0].place, refresh: false }
    const card = this.places.card
    const cardFirst = card !== null && !card.leaving
    const rank = (c) => (c.place.kind === 'card') === cardFirst ? 0 : 1
    for (const c of mine) {
      const [st] = await this.places.stats(c.place, [c.place.libraryPath(c.name)])
      c.size = st === null ? -1 : st.size
    }
    let good = mine.filter((c) => c.size === track.size)
    if (good.length > 1) {
      const same = []
      for (const c of good) {
        try {
          if (await this.places.hashOf(c.place, c.place.libraryPath(c.name)) === track.fileHash) same.push(c)
        } catch {}
      }
      good = same
    }
    const keep = (good.length > 0 ? good : mine).slice().sort((a, b) => rank(a) - rank(b))[0]
    for (const c of mine) if (c !== keep) await this._removeCopy(c)
    return { place: keep.place, refresh: good.length === 0 }
  }

  async _removeCopy (c) {
    const file = c.place.libraryPath(c.name)
    if (c.place.kind === 'internal') unlinkQuiet(file)
    else await this.places.remove(c.place, file)
  }

  // The tracks whose file is not the size the log says are read again.
  async _refreshChanged (sized) {
    let refreshed = 0
    const byPlace = new Map()
    const again = []
    for (const s of sized) {
      if (s.place === undefined) {
        again.push(s.track)
        continue
      }
      if (!byPlace.has(s.place)) byPlace.set(s.place, [])
      byPlace.get(s.place).push(s.track)
    }
    for (const [place, tracks] of byPlace) {
      for (let k = 0; k < tracks.length; k += 2000) {
        const part = tracks.slice(k, k + 2000)
        const sts = await this.places.stats(place, part.map((t) => place.libraryPath(trackFileName(t))))
        part.forEach((t, i) => { if (sts[i] !== null && sts[i].size !== t.size) again.push(t) })
      }
    }
    for (const track of again) {
      const now = this.tracks.get(track.id)
      if (now === undefined) continue
      try {
        await this._refreshFromFile(now)
        refreshed++
      } catch (err) {
        logError('library: cannot re-read ' + trackFileName(now) + ': ' + err.message)
      }
    }
    return refreshed
  }

  // Ids the log does not know: each its newest file (preferring the place its
  // kind goes to), the others go. Returns how many were adopted.
  async _adopt (files, { atStart }) {
    let adopted = 0
    for (const [id, copies] of files) {
      const withTime = []
      for (const c of copies) {
        const [st] = await this.places.stats(c.place, [c.place.libraryPath(c.name)])
        withTime.push({ ...c, mtime: st === null ? 0 : st.mtimeMs })
      }
      withTime.sort((a, b) => b.mtime - a.mtime)
      for (const c of withTime.slice(1)) await this._removeCopy(c)
      const first = withTime[0]
      try {
        const t = this._put(await this._readFile(id, first.name, first.place))
        this._place[t[SLOT]] = first.place.code
        adopted++
      } catch (err) {
        logError('library: cannot read ' + first.name + ': ' + err.message)
      }
    }
    return adopted
  }

  // The Map in addedAt order (a stable sort): every track takes its place again
  // and no delta crosses the change.
  _reorderByDate () {
    const all = [...this.tracks.values()].sort((a, b) => a.addedAt - b.addedAt)
    this.tracks = new Map(all.map((t) => [t.id, t]))
    for (const t of all) this._seq[t[SLOT]] = ++this._seqN
    this._mark('z')
    this._reordered = true
  }

  /**
   * Try again to delete the files in `gone` from internal memory; a name a track
   * uses again (the same bytes uploaded since) just leaves the list. While a
   * card is configured a name leaves only once the card's sweep found it gone
   * there too (a card away keeps its names until it comes back). Returns
   * whether the list changed.
   */
  _sweepGone ({ retry = false } = {}) {
    let changed = false
    let held = 0
    const internal = this.places.internal
    const onCard = this.places.card !== null
    for (const name of [...this._gone]) {
      const m = LIBRARY_FILE_RE.exec(name)
      const t = this.tracks.get(m[1])
      const used = t !== undefined && trackFileName(t) === name
      if (used) {
        this._goneDelete(name)
        changed = true
        continue
      }
      if (!removeAside(internal.libraryPath(name), internal.tmpDir, { retry })) {
        held++
        continue
      }
      if (onCard) continue
      this._goneDelete(name)
      changed = true
    }
    this._heldNames = held
    return changed
  }

  /** The names of gone on a ready card: removed there, and out of the list once nowhere. */
  async _sweepGoneCard () {
    const card = this.places.card
    if (card === null || !card.ready || this._gone.size === 0) return
    const done = []
    const internal = this.places.internal
    for (const name of [...this._gone]) {
      const m = LIBRARY_FILE_RE.exec(name)
      const t = this.tracks.get(m[1])
      if (t !== undefined && trackFileName(t) === name) continue
      if (await this.places.remove(card, card.libraryPath(name)) && !fs.existsSync(internal.libraryPath(name))) done.push(name)
      if (!card.ready) return
    }
    if (done.length > 0) {
      this.batch(() => {
        for (const name of done) if (this._gone.has(name)) this._goneDelete(name)
      })
    }
  }

  // Names a program holds on internal memory are tried again later; names that
  // wait for a card wait for its return, with no timer.
  _sweepLater () {
    if (this._goneTimer !== null || this._closed || this._heldNames === 0) return
    this._goneTimer = setTimeout(() => {
      this._goneTimer = null
      if (this._closed) return
      try {
        this.batch(() => this._sweepGone())
      } catch (err) {
        logError('library: gone list not written: ' + err.message)
      }
      if (this._heldNames > 0) this._sweepLater()
    }, this.goneRetryMs)
    this._goneTimer.unref()
  }

  // ---------------------------------------------------------- memory card

  /** Which memory card the log says holds music (its marker's id), or none. */
  setCardInUse (id) {
    if (this._cardId === id) return
    this.batch(() => {
      this._cardId = id
      this._mark('p')
    })
  }

  get cardInUse () {
    return this._cardId
  }

  /** The owner chose a card: read as a return (a card this source used before gives its files back). */
  cardChosen () {
    return this._cardReturn()
  }

  // The card came back with our marker: listed, its copies settled, the names
  // of gone swept there, what the log does not know adopted at the end, and the
  // codes written in one batch.
  _cardReturn () {
    if (this._returning === null) {
      this._returning = (async () => {
        if (this._opening !== null) await this._opening
        await this.places.migrateFlat(this.places.card)
        await this._cardBack()
      })().finally(() => { this._returning = null })
    }
    return this._returning
  }

  async _cardBack () {
    const card = this.places.card
    if (card === null || !card.ready || this._closed) return
    await this._cleanCardTmp(card)
    this.batch(() => this._sweepGone())
    await this._sweepGoneCard()
    const files = new Map()
    const r = await this._listInto(card, files)
    if (!card.ready || this._closed) return
    const onCard = new Set(files.keys())
    const back = []
    const sized = []
    let n = 0
    for (const [id, copies] of [...files]) {
      if (++n % TRACK_SLICE === 0) await yieldNow()
      const track = this.tracks.get(id)
      if (track === undefined) continue
      files.delete(id)
      const s = track[SLOT]
      const all = this._place[s] === CODE.internal ? [...copies, { name: trackFileName(track), place: this.places.internal }] : copies
      const kept = await this._keepOne(track, all)
      const now = this.tracks.get(id)
      if (kept === null || now === undefined) continue
      if (this._place[s] !== kept.place.code) back.push(id)
      this._place[s] = kept.place.code
      sized.push(kept.refresh ? { track: now } : { track: now, place: kept.place })
    }
    await this._refreshChanged(sized)
    // Tracks the card was to hold and does not: dropped only when every place
    // was listed whole (as a start would).
    const lost = []
    if (r.complete && this._internalComplete) {
      for (const t of this.tracks.values()) {
        const p = this._place[t[SLOT]]
        if ((p === CODE.card || p === CODE.unknown) && !onCard.has(t.id)) lost.push(t.id)
      }
    }
    // What the log does not know goes at the end, as a new upload: no reorder.
    const adopted = await this._adopt(files, { atStart: false })
    await this.onCardBack(back)
    this.places.setListed(card, 'ready')
    const ids = []
    for (const t of this.tracks.values()) if (this._place[t[SLOT]] !== CODE.internal || back.includes(t.id)) ids.push(t.id)
    this.batch(() => {
      for (const id of lost) {
        const t = this.tracks.get(id)
        if (t !== undefined && this._place[t[SLOT]] !== CODE.internal) this._delete(id)
      }
      for (const id of ids) {
        const t = this.tracks.get(id)
        if (t !== undefined && this._codeOf(t) !== this._code[t[SLOT]]) this._markDerived(id, t)
      }
    })
    if (adopted > 0 || lost.length > 0) log('library: the memory card is back: ' + back.length + ' track(s) back, ' + adopted + ' adopted, ' + lost.length + ' missing')
  }

  async _cleanCardTmp (card) {
    let names = []
    try {
      names = await this.places.cardCall(() => this.places.io.readdir(card.tmpDir))
    } catch {
      return
    }
    for (const name of names) {
      await this.places.cardCall(() => this.places.io.unlink(path.join(card.tmpDir, name)), { write: true }).catch(() => {})
    }
  }

  // The card stayed away: its transcodes leave, and every code is compared again
  // (bit 5 for the tracks it holds, their spilled levels): one batch.
  _cardListedAway () {
    if (this._closed) return
    this.onCardGone()
    try {
      this.derivedChanged([...this.tracks.keys()])
    } catch (err) {
      logError('library: the codes of the tracks on the memory card not written: ' + err.message)
    }
  }

  /**
   * The owner forgets the card: its tracks not found on internal memory leave
   * the library as a start drops a track whose file is missing (the people's
   * lists keep the ids), and the log says no card holds music. Nothing is
   * written on the card. Returns the tracks that left.
   */
  forgetCard () {
    const left = []
    this.batch(() => {
      for (const t of [...this.tracks.values()]) {
        if (this._place[t[SLOT]] === CODE.internal) continue
        this._delete(t.id)
        left.push(t)
      }
      this._cardId = null
      this._mark('p')
    })
    runQuietly(() => this.onDropped(left))
    return left
  }

  /** The tracks whose original is not here now (bit 5). */
  awayIds () {
    const out = []
    for (const t of this.tracks.values()) if (this._codeOf(t) & AWAY) out.push(t.id)
    return out
  }

  /** How many tracks have their original on the card, and how many of them are away. */
  cardCounts () {
    let tracks = 0
    let away = 0
    for (const t of this.tracks.values()) {
      const p = this._place[t[SLOT]]
      if (p === CODE.internal) continue
      tracks++
      if (this._codeOf(t) & AWAY) away++
    }
    return { tracks, away }
  }

  /** The place of a track's original (null: not known now). */
  placeOfTrack (track) {
    const cur = this.tracks.get(track.id)
    if (cur === undefined) return this.places.internal
    return this.places.byCode(this._place[cur[SLOT]])
  }

  /** Can the track's original be read now? */
  originalReady (track) {
    const place = this.placeOfTrack(track)
    return place !== null && place.readable
  }

  /**
   * An upload of the very bytes of a track whose original is away: committed
   * for it on internal memory (the track plays again); the card's copy is
   * settled when the card is listed again. False when the original is here.
   */
  restoreFile (track, file) {
    const t = this.tracks.get(track.id)
    if (t === undefined || this.originalReady(t) || t.fileHash !== track.fileHash) return false
    const name = trackFileName(t)
    this.places.commitSync(file, 'library/' + t.id.slice(0, 2) + '/' + name)
    this._place[t[SLOT]] = CODE.internal
    this.derivedChanged([t.id])
    return true
  }

  /** The track's original moved to `place` (the move job): nothing is written to the log. */
  setPlace (id, place) {
    const t = this.tracks.get(id)
    if (t !== undefined) this._place[t[SLOT]] = place.code
  }

  /**
   * Run `fn` with a path of the track's original that a tool may open: the file
   * itself on internal memory, a copy in internal tmp/ for a card file (no tool
   * ever holds a card file open). Throws when the original is not here.
   */
  async withLocalFile (track, fn, { signal = null } = {}) {
    const place = this.placeOfTrack(track)
    if (place === null || !place.readable) throw Object.assign(new Error('the original is not here now'), { code: 'ECARDAWAY' })
    const copy = await this.places.localCopy(place, this.trackPath(track), { signal })
    try {
      return await fn(copy.file)
    } finally {
      copy.done()
    }
  }

  async _fileHashOf (file) {
    const hash = crypto.createHash('sha256')
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
    return hash.digest('hex').slice(0, 24)
  }

  async _parseFile (file) {
    const st = fs.statSync(file)
    const head = Buffer.alloc(Math.min(HEAD_BYTES, st.size))
    const fd = fs.openSync(file, 'r')
    try {
      fs.readSync(fd, head, 0, head.length, 0)
    } finally {
      fs.closeSync(fd)
    }
    const { metadata } = await readAudio(file, sniffAudio(head), { duration: false })
    return { st, metadata }
  }

  // Rebuild a track from a file of a place (tags re-read; no original file
  // name). A card file is read from a copy in internal tmp/.
  async _readFile (id, name, place = this.places.internal) {
    const copy = await this.places.localCopy(place, place.libraryPath(name)) // name matched LIBRARY_FILE_RE
    try {
      return await this._readLocal(id, name, copy.file, place.kind === 'internal' ? null : (await this.places.stats(place, [place.libraryPath(name)]))[0])
    } finally {
      copy.done()
    }
  }

  async _readLocal (id, name, file, cardStat) {
    const { st: local, metadata } = await this._parseFile(file)
    const st = cardStat || local
    const format = LIBRARY_FILE_RE.exec(name)[2] // the extension we chose at upload
    let coverId = null
    try {
      coverId = saveCover(metadata, this.coversDir)
    } catch {}
    const track = buildTrack({ id, format, metadata, size: st.size, fallbackTitle: id, coverId, addedAt: Math.round(st.mtimeMs) })
    track.fileHash = await this._fileHashOf(file)
    return normalizeTrack({ ...track, uploaders: [], fp: null, fpState: 'none' })
  }

  // The file under a track is not the one the log describes: hash it again and
  // take its technical fields; fingerprint and quality are made again.
  async _refreshFromFile (track) {
    const next = await this.withLocalFile(track, async (file) => {
      const { st, metadata } = await this._parseFile(file)
      const fresh = buildTrack({ id: track.id, format: track.format, metadata, size: st.size, fallbackTitle: track.title, coverId: track.coverId, addedAt: track.addedAt })
      const next = { ...track }
      for (const k of ['size', 'bitrate', 'duration', 'lossless', 'codec', 'sampleRate', 'bitDepth']) next[k] = fresh[k]
      next.fileHash = await this._fileHashOf(file)
      return next
    })
    next.fp = null
    next.fpState = 'none'
    unanalysed(next)
    this._put(next)
  }

  _cleanTmp () {
    // Uploads in flight, extraction dirs, archives being processed, tail checks,
    // files set aside: nothing in tmp/ survives a restart, but a track's file that
    // a replacement had just moved aside when the server stopped goes back.
    for (const name of fs.readdirSync(this.tmpDir)) {
      const file = path.join(this.tmpDir, name)
      const back = this._putBackTo(name)
      if (back !== null) {
        try {
          this.places.ensureShardSync(this.places.internal, 'library', path.basename(back).slice(0, 2))
          renameSyncRetry(file, back)
          log('library: ' + path.basename(back) + ' put back from tmp/')
          continue
        } catch (err) {
          logError('library: cannot put back ' + path.basename(back) + ': ' + err.message)
        }
      }
      removeTree(file)
    }
    unlinkQuiet(this.dbFile + '.tmp')
  }

  // library/<ab>/<name> for a file a replacement set aside when the log still
  // names that very file (its name and its hash) and library/ has nothing there;
  // else null.
  _putBackTo (name) {
    const m = SET_ASIDE_RE.exec(name)
    const f = m === null ? null : LIBRARY_FILE_RE.exec(m[2])
    const t = f === null ? undefined : this.tracks.get(f[1])
    if (t === undefined || t.fileHash !== m[1] || trackFileName(t) !== m[2]) return null
    const back = this.places.internal.libraryPath(m[2])
    return fs.existsSync(back) ? null : back
  }

  // Remove covers nothing uses any more (and leftovers of interrupted writes).
  // Embedded covers keep their small/large versions; custom covers have none.
  _cleanCovers () {
    const embedded = new Set()
    for (const t of this.tracks.values()) if (t.coverId) embedded.add(t.coverId)
    const used = new Set(embedded)
    for (const id of this._customCoverIds()) used.add(id)
    for (const id of this.extraCoverIds()) used.add(id)
    // Playlist covers of an older db.json, not in users/ yet.
    if (this.legacyUserData !== null) {
      for (const entry of Object.values(this.legacyUserData.covers.playlist)) {
        if (entry && isCoverId(entry.small)) used.add(entry.small)
        if (entry && isCoverId(entry.large)) used.add(entry.large)
      }
    }
    for (const name of fs.readdirSync(this.coversDir)) {
      const m = COVER_FILE_RE.exec(name)
      if (m !== null) {
        if (!used.has(m[1])) unlinkQuiet(path.join(this.coversDir, name))
        continue
      }
      const sized = COVER_SIZED_RE.exec(name)
      if (sized !== null) {
        if (!embedded.has(sized[1])) unlinkQuiet(path.join(this.coversDir, name))
        continue
      }
      if (name.endsWith('.tmp')) unlinkQuiet(path.join(this.coversDir, name))
    }
  }

  _customCoverIds () {
    const ids = new Set()
    for (const map of Object.values(this.customCovers)) {
      for (const entry of map.values()) {
        if (entry.small) ids.add(entry.small)
        if (entry.large) ids.add(entry.large)
      }
    }
    return ids
  }

  // ----------------------------------------------------------- the log, read

  // Replay library.log into memory: 'none' (no log), 'corrupt' (no valid header) or 'ok'.
  async _replayLog () {
    const st = { header: false, corrupt: false, mode: 'head', changes: false, expect: null, prev: null, lastV: 0, vs: null }
    const done = await replayLog(this.logFile, (text, bytes) => this._replayLine(text, bytes, st), { io: this.io })
    if (done === null) return 'none'
    if (st.corrupt || !st.header) return 'corrupt'
    const current = this._epochs.current
    this.version = current !== null ? Math.max(current[2], st.lastV) : st.lastV
    this.epoch = current !== null ? current[0] : ZERO_EPOCH
    this._diskV = this.version
    this._ringFloor = st.vs !== null ? st.vs : 0
    this._log = new LogFile(this.logFile, { io: this.io, ...(this.syncEveryMs !== undefined ? { syncEveryMs: this.syncEveryMs } : {}) }).open()
    return 'ok'
  }

  // One line of the log; false ends the trusted part there.
  _replayLine (text, bytes, st) {
    let val
    try {
      val = JSON.parse(text)
    } catch {
      if (!st.header) st.corrupt = true
      return false
    }
    if (!st.header) {
      if (!val || typeof val !== 'object' || val.mpfy !== 'library-log' || val.schema !== LOG_SCHEMA) {
        st.corrupt = true
        return false
      }
      st.header = true
      this._from = validStat(val.from)
      return true
    }
    if (Array.isArray(val)) return this._replayChange(val, bytes, st)
    if (val === null || typeof val !== 'object') return false
    if ('e' in val) {
      // An epoch begins: above every version before it; its first change takes E + 1.
      if (st.mode === 'rewritten' || !isEpochId(val.e) || val.e === ZERO_EPOCH || !Number.isSafeInteger(val.v) || val.v <= st.lastV || this._epochs.has(val.e)) return false
      this._epochs.begin(val.e, val.v)
      st.lastV = val.v
      st.expect = val.v + 1
      st.prev = null
      st.changes = true
      return true
    }
    if ('xp' in val) {
      const from = validStat(val.xp)
      if (from === null) return false
      this._from = from
      return true
    }
    // A compacted file's head comes before any change.
    if (st.changes) return false
    if (st.mode === 'head' && 'ep' in val) {
      this._epochs = Epochs.from(val.ep)
      const c = this._epochs.current
      if (c !== null) st.lastV = Math.max(st.lastV, c[2])
      return true
    }
    if (st.mode === 'head' && 'h' in val) {
      if (!Number.isSafeInteger(val.h)) return false
      this._horizon = Math.max(this._horizon, val.h)
      return true
    }
    if (st.mode === 'head' && 'S' in val) {
      if (!Number.isSafeInteger(val.S)) return false
      st.mode = 'rewritten'
      st.vs = val.S
      return true
    }
    if (st.mode === 'rewritten' && 'E' in val) {
      if (!Number.isSafeInteger(val.E)) return false
      st.mode = 'tail'
      st.expect = st.vs + 1
      st.prev = null
      st.lastV = Math.max(st.lastV, st.vs)
      return true
    }
    return false
  }

  _replayChange (val, bytes, st) {
    const v = val[0]
    const key = val[1]
    if (!Number.isSafeInteger(v) || v <= 0 || typeof key !== 'string') return false
    const rewritten = st.mode === 'rewritten'
    if (!rewritten) {
      // The versions of the changes: E + 1 after an epoch line (or Vs + 1 after a
      // rewritten part), then each the previous one or one more.
      if (st.expect !== null) {
        if (v !== st.expect) return false
      } else if (st.prev !== null && v !== st.prev && v !== st.prev + 1) {
        return false
      }
      st.expect = null
      st.prev = v
      st.changes = true
    }
    const ok = this._replayApply(v, key, val, bytes, rewritten)
    if (!ok) return false
    if (!rewritten) {
      if (v > st.lastV) st.lastV = v
      this._epochs.extend(v)
    }
    return true
  }

  // Apply one change line read back. In the rewritten part of a compacted file a
  // line never takes the place of a newer value.
  _replayApply (v, key, val, bytes, rewritten) {
    if (key.startsWith('t:')) {
      const id = key.slice(2)
      if (!isTrackId(id)) return false
      const cur = this.tracks.get(id)
      const newer = cur !== undefined && rewritten && this._cv[cur[SLOT]] > v
      if (val.length === 2) {
        this._tombPush(id, v)
        // A live line of the same version is the id made again in that batch
        // (the tombstone came first there): it stays.
        if (cur !== undefined && !(rewritten && this._cv[cur[SLOT]] >= v)) this._delete(id)
        return true
      }
      const t = val[2]
      const code = val.length > 3 ? val[3] : 0
      if (val.length > 4 || !t || typeof t !== 'object' || t.id !== id || !AUDIO_FORMATS[t.format] || !isCode(code)) return false
      if (newer) return true
      const n = this._put(t)
      const s = n[SLOT]
      this._cv[s] = v
      this._code[s] = code
      this._liveBytes += bytes - this._tlen[s]
      this._tlen[s] = bytes
      if (!rewritten) this._ringPush(v, s)
      return true
    }
    if (key.startsWith('d:')) {
      const id = key.slice(2)
      if (!isTrackId(id) || val.length !== 3 || !isCode(val[2])) return false
      const cur = this.tracks.get(id)
      if (cur === undefined) return true
      const s = cur[SLOT]
      if (rewritten && this._cv[s] > v) return true
      this._cv[s] = v
      this._code[s] = val[2]
      if (!rewritten) this._ringPush(v, s)
      return true
    }
    if (key.startsWith('c:')) {
      const rest = key.slice(2)
      const colon = rest.indexOf(':')
      const kind = colon === -1 ? '' : rest.slice(0, colon)
      const id = rest.slice(colon + 1)
      if (!Object.prototype.hasOwnProperty.call(SHARED_KINDS, kind) || !SHARED_KINDS[kind](id)) return false
      const ck = kind + ':' + id
      const had = this._coverV.get(ck)
      if (rewritten && had !== undefined && had > v) return true
      if (val.length === 2) {
        this.customCovers[kind].delete(id)
        this._coverV.delete(ck)
        this._coverTombSet(ck, v)
        return true
      }
      const e = val[2]
      if (val.length !== 3 || !e || typeof e !== 'object') return false
      const small = isCoverId(e.small) ? e.small : null
      const large = isCoverId(e.large) ? e.large : null
      if (small === null && large === null) {
        this.customCovers[kind].delete(id)
        this._coverV.delete(ck)
        this._coverTombSet(ck, v)
        return true
      }
      this.customCovers[kind].set(id, { small, large })
      this._coverV.set(ck, v)
      this._coverTombs.delete(ck)
      return true
    }
    switch (key) {
      case 'g':
        if (val.length !== 3 || !Array.isArray(val[2])) return false
        if (rewritten && this._gv > v) return true
        this._gone = new Set(val[2].filter((n) => typeof n === 'string' && LIBRARY_FILE_RE.test(n)))
        this._gv = v
        return true
      case 's':
        if (val.length !== 2) return false
        this._sv = Math.max(this._sv, v)
        return true
      case 'z':
        if (val.length !== 2) return false
        this._horizon = Math.max(this._horizon, v)
        return true
      case 'x':
        if (val.length !== 3 || !val[2] || typeof val[2] !== 'object' || Array.isArray(val[2])) return false
        if (rewritten && this._xv > v) return true
        this._extra = val[2]
        this._xv = v
        return true
      case 'p':
        if (val.length === 3 ? !val[2] || typeof val[2] !== 'object' || !/^[0-9a-f]{32}$/.test(val[2].card) : val.length !== 2) return false
        if (rewritten && this._pv > v) return true
        this._cardId = val.length === 3 ? val[2].card : null
        this._pv = v
        return true
    }
    return false
  }

  // ----------------------------------------------------------- the log, made

  _headerLine () {
    const h = { mpfy: 'library-log', schema: LOG_SCHEMA }
    if (this._from !== null) h.from = statLine(this._from)
    return JSON.stringify(h) + '\n'
  }

  // Which memory card holds music (none: the line without a value).
  _cardLine (v) {
    return '[' + v + ',"p"' + (this._cardId !== null ? ',' + JSON.stringify({ card: this._cardId }) : '') + ']\n'
  }

  // A track's line as stored.
  _trackLine (v, t, code) {
    return '[' + v + ',"t:' + t.id + '",' + JSON.stringify(t) + ',' + code + ']\n'
  }

  // The log does not exist yet (a new source, or the first start on db.json):
  // made from the whole state in one synced rename, its epoch opened with it.
  // What changes while it is written is recorded and written right after.
  async _createLog () {
    const io = this.io
    const E = Math.max(this._dbVersion + 1, Date.now())
    const id = newEpochId()
    const tmp = this.logFile + '.tmp'
    this._batch = newBatch(false)
    this._recording = true
    const empty = this.tracks.size === 0 && this.customCovers.track.size === 0 && this.customCovers.album.size === 0 &&
      this._gone.size === 0 && Object.keys(this._extra).length === 0 && this._cardId === null
    let fd = null
    try {
      fd = io.openSync(tmp, 'w', 0o600)
      let pos = 0
      if (empty) {
        pos = writeAllSync(io, fd, Buffer.from(this._headerLine() + JSON.stringify({ e: id, v: E }) + '\n'), pos)
      } else {
        let out = this._headerLine() + JSON.stringify({ ep: [[id, E, E]] }) + '\n{"h":0}\n{"S":' + E + '}\n'
        let live = 0
        for (const t of this.tracks.values()) {
          const s = t[SLOT]
          const code = this._codeOf(t)
          const line = this._trackLine(E, t, code)
          const bytes = Buffer.byteLength(line)
          this._cv[s] = E
          this._code[s] = code
          this._tlen[s] = bytes
          live += bytes
          out += line
          if (out.length >= SLICE_BYTES) {
            pos = writeAllSync(io, fd, Buffer.from(out), pos)
            out = ''
            await yieldNow()
          }
        }
        // Tracks deleted while it was written left their bytes counted: counted again.
        live = 0
        for (const t of this.tracks.values()) live += this._tlen[t[SLOT]]
        this._liveBytes = live
        for (const [kind, map] of Object.entries(this.customCovers)) {
          for (const [cid, entry] of map) {
            out += '[' + E + ',"c:' + kind + ':' + cid + '",' + JSON.stringify({ small: entry.small, large: entry.large }) + ']\n'
            this._coverV.set(kind + ':' + cid, E)
          }
        }
        if (this._gone.size > 0) {
          out += '[' + E + ',"g",' + JSON.stringify([...this._gone]) + ']\n'
          this._gv = E
        }
        if (Object.keys(this._extra).length > 0) {
          out += '[' + E + ',"x",' + JSON.stringify(this._extra) + ']\n'
          this._xv = E
        }
        if (this._cardId !== null) {
          out += this._cardLine(E)
          this._pv = E
        }
        out += '{"E":' + E + '}\n'
        pos = writeAllSync(io, fd, Buffer.from(out), pos)
      }
      await fsyncAsync(io, fd)
      io.closeSync(fd)
      fd = null
      renameRetry(io, tmp, this.logFile)
      io.fsyncDirSync(this.dataDir)
    } catch (err) {
      if (fd !== null) try { io.closeSync(fd) } catch {}
      try { io.unlinkSync(tmp) } catch {}
      throw err
    }
    this._log = new LogFile(this.logFile, { io, ...(this.syncEveryMs !== undefined ? { syncEveryMs: this.syncEveryMs } : {}) }).open()
    this._epochs = new Epochs([[id, E, E]])
    this._horizon = 0
    this.version = E
    this.epoch = id
    this._diskV = E
    this._epochOpen = true
    this._ringFloor = E
    this._endHold()
  }

  // ---------------------------------------------------------------- batches

  /**
   * Every change made in `fn` shares one version and one write. `fn` runs
   * synchronously: what it changes after an await is outside the batch (each such
   * change is written on its own). A write refused by the disk undoes a batch of
   * up to 1,000 tracks and throws its error (507, 500).
   */
  batch (fn) {
    if (this._batch === null) this._batch = newBatch(true)
    this._depth++
    let result
    let failure = null
    try {
      result = fn()
    } catch (err) {
      failure = err
    }
    this._depth--
    if (this._depth === 0) {
      const b = this._batch
      this._batch = null
      this._commit(b)
    }
    if (failure !== null) throw failure
    return result
  }

  // The batch entry of a track about to change (null while nothing is recorded).
  _touch (id, cur) {
    const b = this._batch
    if (b === null || !this._recording) return null
    let rec = b.tracks.get(id)
    if (rec === undefined) {
      rec = { existed: cur !== undefined, t: false, d: false, del: false, before: null }
      if (b.undoable && b.tracks.size >= UNDO_LIMIT) this._stopUndo(b)
      if (b.undoable && cur !== undefined) {
        const s = cur[SLOT]
        rec.before = { obj: cur, slot: s, seq: this._seq[s], sig: this._saveSig(s) }
      }
      b.tracks.set(id, rec)
    }
    return rec
  }

  // The batch is too big (or holds facts that cannot be taken back): a failed
  // write keeps it in memory instead.
  _stopUndo (b) {
    if (!b.undoable) return
    b.undoable = false
    for (const rec of b.tracks.values()) rec.before = null
    b.savedCovers.clear()
    b.savedGone = null
    b.onUndo = []
  }

  _mark (what) {
    const b = this._batch
    if (b === null || !this._recording) return
    b[what] = true
    this._stopUndo(b)
  }

  _markDerived (id, t) {
    const rec = this._touch(id, t)
    if (rec === null) return
    rec.d = true
    this._stopUndo(this._batch)
  }

  // Run once the current batch is written (at once outside a batch, or when the
  // batch would not be undone anyway).
  _after (fn) {
    const b = this._batch
    if (b !== null && b.undoable) b.after.push(fn)
    else runQuietly(fn)
  }

  _onUndo (fn) {
    const b = this._batch
    if (b !== null && b.undoable) b.onUndo.push(fn)
  }

  _commit (b) {
    if (b === null) return
    if (isEmptyBatch(b) && this._unwritten === null) {
      this._runAfter(b)
      return
    }
    if (this._closed || this._log === null) {
      this._runAfter(b)
      return
    }
    const all = this._unwritten !== null ? mergeBatches(this._unwritten, b) : b
    const opening = !this._epochOpen || this._unwritten !== null
    let E = 0
    let epochId = null
    let v
    if (opening) {
      // Above the last version on disk, the clock, and any version shown meanwhile.
      E = Math.max(this._diskV + 1, Date.now(), this.version + 1)
      epochId = newEpochId()
      v = E + 1
    } else {
      v = this.version + 1
    }
    const start = this._log.size
    const updates = []
    const chunks = []
    let out = opening ? JSON.stringify({ e: epochId, v: E }) + '\n' : ''
    const flush = () => {
      if (out === '') return
      const buf = Buffer.from(out)
      out = ''
      this._log.append(buf)
      chunks.push(buf)
    }
    try {
      // The tracks gone (also those created again: removed, then changed).
      for (const [id, r] of all.tracks) {
        if (!r.existed || (!r.del && this.tracks.has(id))) continue
        out += '[' + v + ',"t:' + id + '"]\n'
        updates.push({ k: 'tomb', id })
      }
      const live = []
      for (const [id, r] of all.tracks) {
        const t = this.tracks.get(id)
        if (t !== undefined) live.push({ t, full: r.t || r.del || !r.existed })
      }
      live.sort((a, b) => this._seq[a.t[SLOT]] - this._seq[b.t[SLOT]])
      for (const { t, full } of live) {
        const s = t[SLOT]
        const code = this._codeOf(t)
        if (full) {
          const line = this._trackLine(v, t, code)
          out += line
          updates.push({ k: 't', s, code, bytes: Buffer.byteLength(line) })
        } else if (code !== this._code[s]) {
          out += '[' + v + ',"d:' + t.id + '",' + code + ']\n'
          updates.push({ k: 'd', s, code })
        }
        if (out.length >= CHUNK_BYTES) flush()
      }
      for (const ck of all.covers) {
        const colon = ck.indexOf(':')
        const entry = this.customCovers[ck.slice(0, colon)].get(ck.slice(colon + 1))
        if (entry !== undefined) out += '[' + v + ',"c:' + ck + '",' + JSON.stringify({ small: entry.small, large: entry.large }) + ']\n'
        else out += '[' + v + ',"c:' + ck + '"]\n'
        updates.push({ k: 'c', ck, live: entry !== undefined })
      }
      if (all.g) out += '[' + v + ',"g",' + JSON.stringify([...this._gone]) + ']\n'
      if (all.s) out += '[' + v + ',"s"]\n'
      if (all.x) out += '[' + v + ',"x",' + JSON.stringify(this._extra) + ']\n'
      if (all.z) out += '[' + v + ',"z"]\n'
      if (all.p) out += this._cardLine(v)
      if (updates.length === 0 && !all.g && !all.s && !all.x && !all.z && !all.p) {
        // Nothing moved after all (a derived code back to what was written): no
        // line, and no epoch opened for nothing.
        this._unwritten = null
        this._freeAll(b.freed)
        this._runAfter(b)
        return
      }
      flush()
    } catch (err) {
      if (this._log.size !== start) this._log.cutBack(start)
      return this._writeFailed(b, all, err, { v, E, epochId, opening, updates })
    }
    this._applyWritten({ v, E, epochId, opening, updates, all })
    this._diskV = v
    this._unwritten = null
    if (this._retryTimer !== null) clearTimeout(this._retryTimer)
    this._retryTimer = null
    if (this._kept !== null) for (const c of chunks) this._kept.push(c)
    this.writes++
    this._freeAll(b.freed)
    this._runAfter(b)
    this._maybeCompact()
  }

  // The indexes take what was written (or what memory keeps when it was not).
  _applyWritten ({ v, E, epochId, opening, updates, all }) {
    for (const u of updates) {
      if (u.k === 'tomb') {
        this._tombPush(u.id, v)
      } else if (u.k === 't') {
        this._liveBytes += u.bytes - this._tlen[u.s]
        this._tlen[u.s] = u.bytes
        this._cv[u.s] = v
        this._code[u.s] = u.code
        this._ringPush(v, u.s)
      } else if (u.k === 'd') {
        this._cv[u.s] = v
        this._code[u.s] = u.code
        this._ringPush(v, u.s)
      } else if (u.live) {
        this._coverV.set(u.ck, v)
        this._coverTombs.delete(u.ck)
      } else {
        this._coverV.delete(u.ck)
        this._coverTombSet(u.ck, v)
      }
    }
    if (all.g) this._gv = v
    if (all.s) this._sv = v
    if (all.x) this._xv = v
    if (all.p) this._pv = v
    if (all.z) this._horizon = Math.max(this._horizon, v)
    if (opening) this._epochs.begin(epochId, E)
    this._epochs.extend(v)
    this._epochOpen = true
    this.version = v
    this.epoch = this._epochs.current[0]
  }

  _writeFailed (b, all, err, w) {
    const failure = err instanceof HttpError ? err : new HttpError(500, 'Errore interno del server')
    if (b.undoable && this._unwritten === null) {
      this._undo(b)
      throw failure
    }
    // Kept in memory: shown under a version the disk never had (a new epoch is
    // opened for it at the next write), and written again then.
    logError('library.log: a batch of ' + all.tracks.size + ' track change(s) not written (' + err.message + '), kept in memory and written again later')
    this._applyWritten({ ...w, all })
    this._unwritten = stripBatch(all)
    this._freeAll(b.freed)
    this._runAfter(b)
    this._retryLater()
  }

  _retryLater () {
    if (this._retryTimer !== null || this._closed) return
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null
      if (this._closed || this._unwritten === null || this._depth > 0) return
      try {
        this._commit(newBatch(false))
      } catch {}
      if (this._unwritten !== null) this._retryLater()
    }, RETRY_MS)
    this._retryTimer.unref()
  }

  // A refused batch: memory back to where it was.
  _undo (b) {
    let reorder = false
    for (const [id, rec] of b.tracks) {
      const cur = this.tracks.get(id)
      if (!rec.existed) {
        if (cur !== undefined) {
          this.tracks.delete(id)
          this._bySlot[cur[SLOT]] = undefined
        }
        continue
      }
      const before = rec.before
      if (cur !== undefined && cur[SLOT] === before.slot && !rec.del) {
        this.tracks.set(id, before.obj)
      } else {
        if (cur !== undefined) {
          this.tracks.delete(id)
          this._bySlot[cur[SLOT]] = undefined
        }
        this.tracks.set(id, before.obj)
        reorder = true
      }
      this._bySlot[before.slot] = before.obj
      this._seq[before.slot] = before.seq
      this._restoreSig(before.slot, before.sig)
    }
    for (const s of b.allocated) this._freeSlot(s)
    if (reorder) {
      const all = [...this.tracks.values()].sort((x, y) => this._seq[x[SLOT]] - this._seq[y[SLOT]])
      this.tracks = new Map(all.map((t) => [t.id, t]))
    }
    for (const [kind, entries] of b.savedCovers) this.customCovers[kind] = new Map(entries)
    if (b.savedGone !== null) this._gone = b.savedGone
    for (const fn of b.onUndo) runQuietly(fn)
  }

  _runAfter (b) {
    for (const fn of b.after) runQuietly(fn)
  }

  _freeAll (slots) {
    for (const s of slots) this._freeSlot(s)
  }

  // ------------------------------------------------------------------ slots

  _grow (need) {
    if (need <= this._cap) return
    let cap = Math.max(1024, this._cap)
    while (cap < need) cap = Math.ceil(cap * 1.5)
    const grow = (Kind, old) => {
      const a = new Kind(cap)
      a.set(old)
      return a
    }
    this._cv = grow(Float64Array, this._cv)
    this._seq = grow(Float64Array, this._seq)
    this._code = grow(Uint8Array, this._code)
    this._place = grow(Uint8Array, this._place)
    this._tlen = grow(Uint32Array, this._tlen)
    this._sigLen = grow(Uint16Array, this._sigLen)
    this._sigGen = grow(Uint32Array, this._sigGen)
    const arena = Buffer.alloc(cap * SIG_BYTES)
    this._arena.copy(arena)
    this._arena = arena
    this._cap = cap
  }

  _allocSlot () {
    let s
    if (this._free.length > 0) {
      s = this._free.pop()
    } else {
      s = this._bySlot.length
      this._grow(s + 1)
      this._bySlot.push(undefined)
    }
    this._cv[s] = 0
    this._code[s] = 0
    this._place[s] = CODE.internal
    this._tlen[s] = 0
    this._sigLen[s] = 0
    const b = this._batch
    if (b !== null && this._recording && b.undoable) b.allocated.push(s)
    return s
  }

  _freeSlot (s) {
    if (this._bySlot[s] !== undefined && this.tracks.get(this._bySlot[s].id) === this._bySlot[s]) return
    this._bySlot[s] = undefined
    this._liveBytes -= this._tlen[s]
    this._tlen[s] = 0
    this._cv[s] = 0
    this._code[s] = 0
    this._sigLen[s] = 0
    this._sigGen[s]++ // a copy still pointing here reads no signature
    this._free.push(s)
    runQuietly(() => this.onSlotFree(s))
  }

  /** The slot of a track of this library, or -1. */
  slotOf (id) {
    const t = this.tracks.get(id)
    return t === undefined ? -1 : t[SLOT]
  }

  /** The track at a slot, or null. */
  trackAt (slot) {
    const t = this._bySlot[slot]
    return t === undefined ? null : t
  }

  // -------------------------------------------------------- the signatures

  _sigString (slot, gen) {
    if (this._sigGen[slot] !== gen || this._sigLen[slot] === 0) return null
    const at = slot * SIG_BYTES
    return this._arena.toString('base64', at, at + this._sigLen[slot])
  }

  // A signature into the arena at `slot`; null when its text would not come back
  // the same (kept as it is then).
  _writeSig (slot, fp) {
    const bytes = Buffer.from(fp.s, 'base64')
    if (bytes.length === 0 || bytes.length > SIG_BYTES || bytes.toString('base64') !== fp.s) return null
    bytes.copy(this._arena, slot * SIG_BYTES)
    this._sigLen[slot] = bytes.length
    const gen = ++this._sigGen[slot]
    return Object.freeze(new this._Sig(fp.d, fp.b, slot, gen))
  }

  _saveSig (slot) {
    const len = this._sigLen[slot]
    const at = slot * SIG_BYTES
    return { len, gen: this._sigGen[slot], bytes: len > 0 ? Buffer.from(this._arena.subarray(at, at + len)) : null }
  }

  _restoreSig (slot, sig) {
    if (sig === null) return
    if (sig.bytes !== null) sig.bytes.copy(this._arena, slot * SIG_BYTES)
    this._sigLen[slot] = sig.len
    this._sigGen[slot] = sig.gen
  }

  // ------------------------------------------------------- the stored form

  _str (s) {
    if (typeof s !== 'string') return s
    const known = this._strings.get(s)
    if (known !== undefined) return known
    this._strings.set(s, s)
    return s
  }

  // A frozen array shared by every track with the same content.
  _arr (a) {
    if (!Array.isArray(a)) return a
    if (a.length === 0) return EMPTY
    const key = a.join('\u0000')
    const known = this._arrays.get(key)
    if (known !== undefined) return known
    const frozen = Object.freeze(a.map((x) => this._str(x)))
    this._arrays.set(key, frozen)
    return frozen
  }

  /**
   * Store a track (a new object; its id keeps its slot, a new id takes a free one).
   * Returns the stored object.
   */
  _put (next, legacy = false) {
    const id = next.id
    const cur = this.tracks.get(id)
    this._touch(id, cur)
    const slot = cur !== undefined ? cur[SLOT] : this._allocSlot()
    // The signature: one already in this slot stays; a copy whose id left the
    // library (or whose slot holds another signature since) loses it, and it is
    // made again.
    const f = next.fp
    let keep = null
    let plain = null
    if (f instanceof this._Sig) {
      if (cur !== undefined && f[SIG_SLOT] === slot && f[SIG_GEN] === this._sigGen[slot]) keep = f
    } else if (validSignature(f)) {
      plain = f
    }
    const n = storedTrack(next, legacy, keep !== null ? keep : plain)
    if (plain !== null && n.fp !== null) {
      const sig = this._writeSig(slot, plain)
      n.fp = sig !== null ? sig : Object.freeze({ d: plain.d, b: plain.b, s: plain.s })
    }
    if (n.fp === null) this._sigLen[slot] = 0
    this._compactTrack(n)
    n[SLOT] = slot
    if (this.freezeTracks) {
      if (n.lookup) Object.freeze(n.lookup)
      Object.freeze(n)
    }
    this.tracks.set(id, n)
    this._bySlot[slot] = n
    if (cur === undefined) this._seq[slot] = ++this._seqN
    const b = this._batch
    if (b !== null && this._recording) b.tracks.get(id).t = true
    return n
  }

  _compactTrack (n) {
    n.artist = this._str(n.artist)
    n.albumArtist = this._str(n.albumArtist)
    n.album = this._str(n.album)
    n.format = this._str(n.format)
    n.mime = this._str(n.mime)
    n.codec = this._str(n.codec)
    n.fpState = this._str(n.fpState)
    if (n.fileHash === n.id) n.fileHash = n.id
    n.uploaders = this._arr(n.uploaders)
    n.notSame = this._arr(n.notSame)
    n.tagless = this._arr(n.tagless)
    n.genres = this._arr(n.genres)
    n.edited = this._arr(n.edited)
    if (n.lookup) {
      n.lookup.state = this._str(n.lookup.state)
      if (n.lookup.fileHash === n.id) n.lookup.fileHash = n.id
      n.lookup.filled = this._arr(n.lookup.filled)
    }
  }

  // A track leaves the library (its slot is freed once that is written).
  _delete (id) {
    const cur = this.tracks.get(id)
    if (cur === undefined) return null
    const rec = this._touch(id, cur)
    const s = cur[SLOT]
    this.tracks.delete(id)
    this._bySlot[s] = undefined
    if (rec !== null) {
      rec.del = true
      this._batch.freed.push(s)
    } else {
      this._freeSlot(s)
    }
    return cur
  }

  _coverPut (kind, id, entry) {
    this._saveCovers(kind)
    this.customCovers[kind].set(id, entry)
    const b = this._batch
    if (b !== null && this._recording) b.covers.add(kind + ':' + id)
  }

  _coverDelete (kind, id) {
    this._saveCovers(kind)
    this.customCovers[kind].delete(id)
    const b = this._batch
    if (b !== null && this._recording) b.covers.add(kind + ':' + id)
  }

  _saveCovers (kind) {
    const b = this._batch
    if (b !== null && this._recording && b.undoable && !b.savedCovers.has(kind)) b.savedCovers.set(kind, [...this.customCovers[kind]])
  }

  _goneAdd (name) {
    this._saveGone()
    this._gone.add(name)
    const b = this._batch
    if (b !== null && this._recording) b.g = true
  }

  _goneDelete (name) {
    this._saveGone()
    this._gone.delete(name)
    const b = this._batch
    if (b !== null && this._recording) b.g = true
  }

  _saveGone () {
    const b = this._batch
    if (b !== null && this._recording && b.undoable && b.savedGone === null) b.savedGone = new Set(this._gone)
  }

  // ----------------------------------------------------------- the indexes

  _ringPush (v, slot) {
    if (this._ringCount === RING_SIZE) this._ringFloor = Math.max(this._ringFloor, this._ringV[this._ringHead])
    else this._ringCount++
    this._ringV[this._ringHead] = v
    this._ringS[this._ringHead] = slot
    this._ringHead = (this._ringHead + 1) % RING_SIZE
  }

  _tombPush (id, v) {
    if (this._tombCount === KEEP_TOMBSTONES) this._horizon = Math.max(this._horizon, this._tombV[this._tombHead])
    else this._tombCount++
    this._tombIds.write(id, this._tombHead * 12, 12, 'hex')
    this._tombV[this._tombHead] = v
    this._tombHead = (this._tombHead + 1) % KEEP_TOMBSTONES
  }

  // The tombstones, oldest first: [id, version].
  _tombstones () {
    const out = []
    const base = (this._tombHead - this._tombCount + KEEP_TOMBSTONES) % KEEP_TOMBSTONES
    for (let i = 0; i < this._tombCount; i++) {
      const at = (base + i) % KEEP_TOMBSTONES
      out.push([this._tombIds.toString('hex', at * 12, at * 12 + 12), this._tombV[at]])
    }
    return out
  }

  _coverTombSet (ck, v) {
    this._coverTombs.delete(ck)
    this._coverTombs.set(ck, v)
    if (this._coverTombs.size > KEEP_TOMBSTONES) {
      const [oldest, ov] = this._coverTombs.entries().next().value
      this._coverTombs.delete(oldest)
      this._horizon = Math.max(this._horizon, ov)
    }
  }

  /** The derived code of a track: its ready levels, its lyrics, and whether its original is away. */
  _codeOf (t) {
    const q = this.qualitiesOf(t)
    const l = this.lyricsOf(t.id)
    let code = (q.low ? 1 : 0) | (q.normal ? 2 : 0) | (q.high ? 4 : 0) | (l === 'synced' ? 8 : 0) | (l === 'plain' ? 16 : 0)
    const s = t[SLOT]
    if (s === undefined) return code
    const card = this.places.card
    const pending = card !== null && card.listed === 'pending'
    // While the card is not known yet, a level not ready here may be a
    // transcode spilled onto it, and an original not found may be on it: those
    // bits stay what the log says, so a card slow to mount writes nothing.
    if (pending) code |= this._code[s] & LEVEL_BITS
    const p = this._place[s]
    if (p === CODE.internal || (p === CODE.card && card !== null && card.listed === 'ready')) return code
    if (pending) return code | (this._code[s] & AWAY)
    return code | AWAY
  }

  /**
   * What changed since (epoch, v): null when that version cannot be proved (not an
   * epoch of this log, outside its range, below the horizon): then the full tracks.
   * Else { version, epoch, changed: [ids in Map order], removed: [ids],
   * covers: { track: [ids], album: [ids] } }; an id deleted and made again since is
   * in both lists. The entries are read now.
   */
  changesSince (epoch, v) {
    if (this._holding || !this._epochs.known(epoch, v, this._horizon)) return null
    const slots = []
    if (v >= this._ringFloor) {
      const n = this._ringCount
      const base = (this._ringHead - n + RING_SIZE) % RING_SIZE
      let lo = 0
      let hi = n
      while (lo < hi) {
        const mid = (lo + hi) >>> 1
        if (this._ringV[(base + mid) % RING_SIZE] > v) hi = mid
        else lo = mid + 1
      }
      const seen = new Set()
      for (let i = lo; i < n; i++) {
        const s = this._ringS[(base + i) % RING_SIZE]
        if (seen.has(s)) continue
        seen.add(s)
        if (this._bySlot[s] !== undefined && this._cv[s] > v) slots.push(s)
      }
    } else {
      for (let s = 0; s < this._bySlot.length; s++) if (this._bySlot[s] !== undefined && this._cv[s] > v) slots.push(s)
    }
    slots.sort((a, b) => this._seq[a] - this._seq[b])
    const changed = slots.map((s) => this._bySlot[s].id)
    const removed = []
    const gone = new Set()
    const base = (this._tombHead - this._tombCount + KEEP_TOMBSTONES) % KEEP_TOMBSTONES
    for (let i = this._tombCount - 1; i >= 0; i--) {
      const at = (base + i) % KEEP_TOMBSTONES
      if (this._tombV[at] <= v) break
      const id = this._tombIds.toString('hex', at * 12, at * 12 + 12)
      if (!gone.has(id)) {
        gone.add(id)
        removed.push(id)
      }
    }
    removed.reverse()
    const covers = { track: [], album: [] }
    for (const [ck, cv] of this._coverV) if (cv > v) pushCover(covers, ck)
    for (const [ck, cv] of this._coverTombs) if (cv > v) pushCover(covers, ck)
    return { version: this.version, epoch: this.epoch, changed, removed, covers }
  }

  // ------------------------------------------------------------ compaction

  _maybeCompact (atStart = false) {
    if (this._compacting !== null || this._closed || this._log === null || this._unwritten !== null || this._holding) return
    const dead = this._log.size - this._liveBytes
    const bar = atStart ? this._liveBytes / 4 : this._liveBytes
    if (dead > COMPACT_MIN_DEAD && dead > bar) this._compactLater()
  }

  _compactLater () {
    if (this._compacting !== null) return
    this._compacting = this._compact().finally(() => { this._compacting = null })
  }

  /** Rewrite the log now (one at a time); resolves when it is over. */
  compact () {
    if (this._log === null || this._closed) return Promise.resolve()
    this._compactLater()
    return this._compacting
  }

  /** Resolves when no compaction runs (tests, close). */
  settled () {
    return this._compacting === null ? Promise.resolve() : this._compacting
  }

  // The log written again: every live track with its own version in the Map's
  // order, the covers, the lists, the newest tombstones, then the lines appended
  // meanwhile. A crash leaves the old file whole (plus a .tmp the next open
  // deletes) or the new one whole; nothing synced before is lost by a power cut.
  async _compact () {
    const io = this.io
    const tmp = this.logFile + '.tmp'
    const vs = this.version
    this._kept = []
    let fd = null
    let liveClosed = false
    try {
      fd = io.openSync(tmp, 'w', 0o600)
      let pos = 0
      this._horizon = this._epochs.trim(this._horizon)
      let out = this._headerLine() + JSON.stringify({ ep: this._epochs.toJSON() }) + '\n{"h":' + this._horizon + '}\n{"S":' + vs + '}\n'
      const write = () => {
        pos = writeAllSync(io, fd, Buffer.from(out), pos)
        out = ''
      }
      for (const t of this.tracks.values()) {
        const s = t[SLOT]
        const line = this._trackLine(this._cv[s], t, this._code[s])
        const bytes = Buffer.byteLength(line)
        this._liveBytes += bytes - this._tlen[s]
        this._tlen[s] = bytes
        out += line
        if (out.length >= SLICE_BYTES) {
          write()
          await yieldNow()
          if (this._closed) throw ABORTED
        }
      }
      for (const [kind, map] of Object.entries(this.customCovers)) {
        for (const [id, entry] of map) {
          const cv = this._coverV.get(kind + ':' + id) || vs
          out += '[' + cv + ',"c:' + kind + ':' + id + '",' + JSON.stringify({ small: entry.small, large: entry.large }) + ']\n'
        }
      }
      if (this._gone.size > 0) out += '[' + (this._gv || vs) + ',"g",' + JSON.stringify([...this._gone]) + ']\n'
      if (this._sv > 0) out += '[' + this._sv + ',"s"]\n'
      if (this._xv > 0 && Object.keys(this._extra).length > 0) out += '[' + this._xv + ',"x",' + JSON.stringify(this._extra) + ']\n'
      if (this._cardId !== null) out += this._cardLine(this._pv || vs)
      for (const [id, tv] of this._tombstones()) out += '[' + tv + ',"t:' + id + '"]\n'
      for (const [ck, tv] of this._coverTombs) out += '[' + tv + ',"c:' + ck + '"]\n'
      out += '{"E":' + this.version + '}\n'
      write()
      await fsyncAsync(io, fd)
      if (this._closed) throw ABORTED
      // The lines appended meanwhile, synced in rounds until little is left.
      for (;;) {
        const lines = this._kept
        this._kept = []
        for (const buf of lines) pos = writeAllSync(io, fd, buf, pos)
        await fsyncAsync(io, fd)
        if (this._closed) throw ABORTED
        if (bytesOf(this._kept) < KEPT_LEFT) break
      }
      // From here to the end nothing awaits: no append can come in between.
      for (const buf of this._kept) pos = writeAllSync(io, fd, buf, pos)
      this._kept = null
      io.closeSync(fd)
      fd = null
      this._log.close({ sync: false })
      liveClosed = true
      renameRetry(io, tmp, this.logFile)
      io.fsyncDirSync(this.dataDir)
      this._log = new LogFile(this.logFile, { io, ...(this.syncEveryMs !== undefined ? { syncEveryMs: this.syncEveryMs } : {}) }).open()
      this._log.scheduleSync()
      this.compactions++
    } catch (err) {
      this._kept = null
      if (fd !== null) try { io.closeSync(fd) } catch {}
      try { io.unlinkSync(tmp) } catch {}
      if (liveClosed && !this._closed) {
        try {
          this._log = new LogFile(this.logFile, { io, ...(this.syncEveryMs !== undefined ? { syncEveryMs: this.syncEveryMs } : {}) }).open()
        } catch (again) {
          logError('library.log cannot be opened again: ' + again.message)
        }
      }
      if (err !== ABORTED) logError('library.log not rewritten: ' + err.message)
    }
  }

  // ------------------------------------------------------------ persistence

  /** A reset: no delta crosses it (a change with no id to name). */
  bump () {
    this.batch(() => this._mark('z'))
  }

  /**
   * The source's name, `named` or details switch changed (`s`), or its owner
   * (`z`: the tracks the owner acting without a profile calls its own moved).
   */
  sourceChanged ({ ownerMoved = false } = {}) {
    this.batch(() => this._mark(ownerMoved ? 'z' : 's'))
  }

  /**
   * The ready levels or the lyrics flag of these tracks may have moved: a d: line
   * for each one whose code moved, all in one batch; nothing when none moved.
   */
  derivedChanged (ids) {
    this.batch(() => {
      for (const id of ids) {
        const t = this.tracks.get(id)
        if (t !== undefined && this._codeOf(t) !== this._code[t[SLOT]]) this._markDerived(id, t)
      }
    })
  }

  /** The log synced now (what was appended is on disk). Synchronous, so it also works on exit. */
  flush () {
    if (this._closed || this._log === null) return
    if (this._unwritten !== null && this._depth === 0) {
      try {
        this._commit(newBatch(false))
      } catch {}
    }
    this._log.syncNow()
  }

  /** The same as flush(): the log is always written; this syncs it. */
  flushNow () {
    this.flush()
  }

  close () {
    if (this._closed) return
    if (this._goneTimer !== null) clearTimeout(this._goneTimer)
    this._goneTimer = null
    if (this._retryTimer !== null) clearTimeout(this._retryTimer)
    this._retryTimer = null
    // The start's changes, when the start never ended (the log exists).
    if (this._holding && this._log !== null) {
      try {
        this._endHold()
      } catch {}
    }
    if (this._unwritten !== null && this._log !== null && this._depth === 0) {
      try {
        this._commit(newBatch(false))
      } catch {}
    }
    // Closed BEFORE the file: nothing writes after close (a rewrite under way is
    // given up, its .tmp deleted). Closing syncs it.
    this._closed = true
    if (this._log !== null) this._log.close()
  }

  /**
   * db.json and its stat as an older MPfy reads them (schema 3, today's format),
   * written from the live state in slices by a temporary file, fsync and rename;
   * the log then remembers that db.json (its `xp` line), so it is not read again.
   */
  async exportCompat () {
    const io = this.io
    const tmp = this.dbFile + '.tmp'
    const fd = io.openSync(tmp, 'w', 0o600)
    const hash = crypto.createHash('sha256')
    let pos = 0
    const write = (text) => {
      const buf = Buffer.from(text)
      hash.update(buf)
      pos = writeAllSync(io, fd, buf, pos)
    }
    try {
      let out = JSON.stringify({ ...this._extra, schema: DB_SCHEMA, version: this.version }).slice(0, -1) + ',"tracks":['
      let first = true
      for (const t of this.tracks.values()) {
        out += (first ? '' : ',') + JSON.stringify(t)
        first = false
        if (out.length >= SLICE_BYTES) {
          write(out)
          out = ''
          await yieldNow()
        }
      }
      out += '],"covers":' + JSON.stringify(this.coversSnapshot()) + (this._gone.size > 0 ? ',"gone":' + JSON.stringify([...this._gone]) : '') + '}'
      write(out)
      await fsyncAsync(io, fd)
    } finally {
      io.closeSync(fd)
    }
    renameRetry(io, tmp, this.dbFile)
    io.fsyncDirSync(this.dataDir)
    const st = fs.statSync(this.dbFile)
    const from = { size: st.size, mtimeMs: st.mtimeMs, hash: hash.digest('hex') }
    if (this._log !== null && !this._closed) {
      this._log.append(Buffer.from(JSON.stringify({ xp: from }) + '\n'))
      if (this._kept !== null) this._kept.push(Buffer.from(JSON.stringify({ xp: from }) + '\n'))
      this._log.syncNow()
    }
    this._from = from
    return from
  }

  /** Every track as `viewer` sees it (see publicTrack). */
  publicTracks (viewer = null) {
    return [...this.tracks.values()].map((t) => this.publicTrack(t, viewer))
  }

  /**
   * The JSON array of every track as `viewer` sees it, written to `out` in slices
   * of 250, in the library's order: between slices it waits while `out` asks to
   * (write() false: until 'drain'), so a slow reader never makes the source hold
   * the whole answer. The walk reads the live state: a track changed after its
   * slice went out is written as it was. Rejects when `signal` aborts or `out`
   * closes. Resolves with the count of tracks written.
   */
  async writeTracks (out, viewer = null, { signal = null } = {}) {
    let text = '['
    let n = 0
    for (const t of this.tracks.values()) {
      if (signal !== null && signal.aborted) throw abortError()
      text += (n === 0 ? '' : ',') + JSON.stringify(this.publicTrack(t, viewer))
      n++
      if (n % TRACK_SLICE === 0) {
        const more = out.write(text)
        text = ''
        if (!more) await drained(out, signal)
        else await yieldNow()
      }
    }
    if (signal !== null && signal.aborted) throw abortError()
    if (!out.write(text + ']')) await drained(out, signal)
    return n
  }

  /**
   * A track as clients see it: the public fields, which Opus versions are ready,
   * its lyrics ("synced" or "plain", absent when it has none), and whether it is
   * the caller's own (`mine`) and someone else's (`others`). `viewer` is a Set of
   * the ids that count as the caller (null: nobody).
   */
  publicTrack (t, viewer = null) {
    const out = {}
    for (const k of PUBLIC_FIELDS) out[k] = t[k] === undefined ? null : t[k]
    if (out.fp !== null) out.fp = { d: t.fp.d, b: t.fp.b, s: t.fp.s }
    // Only when it has some: an answer without genres stays as it was before them. The tags'
    // first, else what MusicBrainz gave for this very file.
    const gl = t.genreLookup
    if (t.genres && t.genres.length > 0) out.genres = t.genres
    else if (gl && gl.fileHash === t.fileHash && gl.genres.length > 0) out.genres = gl.genres
    // The same: only when the track has them.
    if (t.sort) out.sort = t.sort
    if (t.loud) out.loud = t.loud
    out.qualities = { ...this.qualitiesOf(t) }
    const lyrics = this.lyricsOf(t.id)
    if (lyrics !== null) out.lyrics = lyrics
    if (this._place !== undefined && t[SLOT] !== undefined && (this._codeOf(t) & AWAY)) out.away = true
    const ups = t.uploaders || []
    out.mine = viewer !== null && ups.some((u) => viewer.has(u))
    out.others = ups.some((u) => viewer === null || !viewer.has(u))
    return out
  }

  // ----------------------------------------------------------------- tracks

  getTrack (id) {
    return isTrackId(id) ? this.tracks.get(id) || null : null
  }

  /** The track whose id or file is these bytes. */
  findByHash (hash) {
    const byId = this.getTrack(hash)
    if (byId !== null) return byId
    for (const t of this.tracks.values()) if (t.fileHash === hash) return t
    return null
  }

  _track (id) {
    if (!isTrackId(id)) throw new HttpError(400, 'Identificativo del brano non valido')
    const t = this.tracks.get(id)
    if (!t) throw new HttpError(404, 'Brano non trovato')
    return t
  }

  /** A track by id, or 404. */
  requireTrack (id) {
    return this._track(id)
  }

  /**
   * The path of a track's original on its place (a track not in the library,
   * being added: internal memory; a place not known now: the card's path).
   */
  trackPath (track) {
    const name = trackFileName(track)
    const cur = this.tracks.get(track.id)
    const p = cur === undefined ? CODE.internal : this._place[cur[SLOT]]
    const card = this.places.card
    if (p !== CODE.internal && card !== null && card.root !== null) return card.libraryPath(name)
    return this.places.internal.libraryPath(name)
  }

  // covers/<coverId>.<ext> if it exists, else null.
  _coverOriginal (coverId) {
    for (const ext of COVER_EXTS) {
      const file = path.join(this.coversDir, coverId + '.' + ext)
      if (fs.existsSync(file)) return { file, ext }
    }
    return null
  }

  coverExists (coverId) {
    return isCoverId(coverId) && this._coverOriginal(coverId) !== null
  }

  /**
   * The file to serve for a cover: with `size` ('small' or 'large') the JPEG
   * version when it exists, else the original. null when unknown.
   * @returns {{ file: string, ext: string, sized: boolean } | null}
   */
  coverPath (coverId, size = null) {
    if (!isCoverId(coverId)) return null
    if (size !== null) {
      const file = this.sizedCoverPath(coverId, size)
      if (fs.existsSync(file)) return { file, ext: 'jpg', sized: true }
    }
    const original = this._coverOriginal(coverId)
    return original === null ? null : { ...original, sized: false }
  }

  /** covers/<coverId>.<size>.jpg (whether or not it exists). */
  sizedCoverPath (coverId, size) {
    if (!isCoverId(coverId) || !COVER_SIZES.includes(size)) throw new Error('invalid cover id or size')
    return path.join(this.coversDir, coverId + '.' + size + '.jpg')
  }

  /** Is this cover embedded in a track of this library (so it gets small/large versions)? */
  isEmbeddedCover (coverId) {
    for (const t of this.tracks.values()) if (t.coverId === coverId) return true
    return false
  }

  /** Embedded cover ids of the library, each once. */
  embeddedCoverIds () {
    const ids = new Set()
    for (const t of this.tracks.values()) if (t.coverId) ids.add(t.coverId)
    return [...ids]
  }

  _coverInUse (coverId) {
    if (this.isEmbeddedCover(coverId)) return true
    return this._customCoverIds().has(coverId) || this.extraCoverIds().has(coverId)
  }

  /** Delete a cover's files when nothing references it any more. */
  dropCoverIfUnused (coverId) {
    if (!coverId || !isCoverId(coverId) || this._coverInUse(coverId)) return
    for (const ext of COVER_EXTS) unlinkQuiet(path.join(this.coversDir, coverId + '.' + ext))
    for (const size of COVER_SIZES) unlinkQuiet(this.sizedCoverPath(coverId, size))
  }

  /** A new track whose file was committed on `place` (internal memory when not said). */
  addTrack (track, place = this.places.internal) {
    return this.batch(() => {
      const n = this._put(track)
      this._place[n[SLOT]] = place.code
      return n
    })
  }

  /** Replace a track object (same id) with changed stored fields. */
  setTrack (track) {
    return this.batch(() => {
      const stored = this._put(track)
      this._after(() => this.onTrackChange(track.id, 'set'))
      return stored
    })
  }

  updateTrack (id, body) {
    const t = this._track(id)
    const next = { ...t }
    if (body.title !== undefined) {
      const v = text(body.title, 500)
      if (!v) throw new HttpError(400, "Il titolo non puo' essere vuoto")
      next.title = v
    }
    if (body.artist !== undefined) {
      const v = text(body.artist, 500) || UNKNOWN_ARTIST
      // albumArtist followed artist (no own tag): keep them together.
      if (t.albumArtist === t.artist) next.albumArtist = v
      next.artist = v
    }
    if (body.album !== undefined) next.album = text(body.album, 500) || UNKNOWN_ALBUM
    // What a person changed is theirs: details from the network never touch it.
    const edited = new Set(t.edited || [])
    for (const k of EDITABLE_FIELDS) if (next[k] !== t[k]) edited.add(k)
    next.edited = EDITABLE_FIELDS.filter((k) => edited.has(k))
    return this.batch(() => {
      const stored = this._put(next)
      this._after(() => this.onTrackChange(id, 'edit'))
      return stored
    })
  }

  /** Add `who` to a track's uploaders (a duplicate upload makes it theirs too). */
  addUploader (id, who) {
    const t = this.getTrack(id)
    if (t === null || t.uploaders.includes(who)) return
    this.batch(() => this._put({ ...t, uploaders: [...t.uploaders, who] }))
  }

  /** Take `who` out of a track's uploaders; returns how many are left. */
  removeUploader (id, who) {
    const t = this._track(id)
    if (!t.uploaders.includes(who)) return t.uploaders.length
    return this.batch(() => this._put({ ...t, uploaders: t.uploaders.filter((u) => u !== who) })).uploaders.length
  }

  /** Every `from` in any uploaders becomes `to` (the claim, set-owner --move-data). */
  replaceUploader (from, to) {
    let changed = false
    this.batch(() => {
      for (const t of this.tracks.values()) {
        if (!t.uploaders.includes(from)) continue
        this._put({ ...t, uploaders: [...new Set(t.uploaders.map((u) => (u === from ? to : u)))] })
        changed = true
      }
    })
    return changed
  }

  /** `who` leaves every uploaders (a removed profile); no file is deleted. */
  dropUploaderEverywhere (who) {
    let changed = false
    this.batch(() => {
      for (const t of this.tracks.values()) {
        if (!t.uploaders.includes(who)) continue
        this._put({ ...t, uploaders: t.uploaders.filter((u) => u !== who) })
        changed = true
      }
    })
    return changed
  }

  /** Two tracks are different songs: each lists the other in notSame. */
  markNotSame (a, b) {
    this.batch(() => {
      for (const [x, y] of [[a, b], [b, a]]) {
        const t = this.getTrack(x)
        if (t !== null && !t.notSame.includes(y)) this._put({ ...t, notSame: [...t.notSame, y] })
      }
    })
  }

  /**
   * The archive's cover image becomes the embedded cover of those of its tracks
   * that have none (one batch). Returns whether any track took it.
   */
  applyArchiveCover (ids, coverId) {
    let changed = false
    this.batch(() => {
      for (const id of ids) {
        const t = this.getTrack(id)
        if (t === null || t.coverId !== null) continue
        const next = { ...t, coverId }
        if (Array.isArray(t.tagless)) next.tagless = t.tagless.filter((f) => f !== 'cover')
        this._put(next)
        changed = true
      }
    })
    return changed
  }

  /**
   * Delete a track of this library: its entry, its file, and its cover when no
   * other track uses it. (Transcodes, fingerprint and user data are the caller's;
   * the caller stops the job reading the file first.) The file goes once its
   * tombstone is written; one a program still holds goes later, listed in `gone`
   * at once, so a restart never adopts it.
   */
  deleteTrack (id) {
    const t = this._track(id)
    const place = this.placeOfTrack(t)
    const name = trackFileName(t)
    this.batch(() => {
      this._delete(id)
      if (place === null || place.kind === 'card') {
        // On the card, or nobody knows where now: listed in gone with its
        // tombstone, without trying (a card away answers ENOENT for every
        // file), so the card's return never brings the track back. A ready
        // card has it removed at once.
        this._goneAdd(name)
        this._after(() => {
          if (place !== null && place.ready) this._sweepGoneCard().catch(() => {})
          if (t.coverId) this.dropCoverIfUnused(t.coverId)
        })
        return
      }
      this._after(() => {
        const internal = this.places.internal
        if (!removeAside(internal.libraryPath(name), internal.tmpDir, { retry: true })) {
          this.batch(() => this._goneAdd(name))
          this._heldNames++
          this._sweepLater()
        }
        if (t.coverId) this.dropCoverIfUnused(t.coverId)
      })
    })
    return t
  }

  /**
   * A better file for a track: `tmp` becomes library/<id>.<ext of the new
   * format> and the log names it at once. The old file steps aside first (on
   * Windows nothing can be renamed over a file someone streams, but that file
   * can be renamed away) and is deleted once the log names the new one. When the
   * new file cannot take its place (or the log refuses the change) the old one
   * goes back and the error reaches the caller (a 409 when a program holds a
   * file). `fields` are the new technical fields; the metadata comes from `meta`
   * as takeTags() says (the caller asks for the lookup). Returns { track, old }.
   */
  replaceFile (id, tmp, fields, meta) {
    const old = this._track(id)
    const next = { ...old, ...fields }
    takeTags(next, meta)
    next.mime = AUDIO_FORMATS[next.format].mime
    const internal = this.places.internal
    const oldPlace = this.placeOfTrack(old)
    if (oldPlace === null || oldPlace.kind === 'card') return this._replaceCardFile(old, next, tmp, oldPlace)
    this.places.ensureShardSync(internal, 'library', next.id.slice(0, 2))
    const dest = internal.libraryPath(trackFileName(next))
    const oldFile = this.trackPath(old)
    // Named after the file it is: if the server stops before the log names the
    // new one, the next start puts it back.
    const aside = asidePath(this.tmpDir, oldFile, 'was-' + old.fileHash)
    let moved = false
    let left = null
    try {
      renameSyncRetry(oldFile, aside)
      moved = true
    } catch (err) {
      // A held file of another format may stay for now: it goes as soon as it can.
      if (oldFile === dest && err.code !== 'ENOENT') throw inUse(err)
      if (err.code !== 'ENOENT') left = trackFileName(old)
    }
    const putBack = () => {
      if (!moved) return
      try {
        renameSyncRetry(aside, oldFile)
      } catch (back) {
        logError('library: ' + path.basename(oldFile) + ' stays in tmp/ until the next start: ' + back.message)
      }
    }
    try {
      renameSyncRetry(tmp, dest)
    } catch (err) {
      putBack()
      throw inUse(err)
    }
    try { fs.chmodSync(dest, 0o644) } catch {}
    this.batch(() => {
      this._put(next)
      if (left !== null) {
        this._goneAdd(left)
        this._heldNames++
      }
      this._onUndo(() => {
        // The log refused it: the new file goes back to where it came from.
        try {
          renameSyncRetry(dest, tmp)
        } catch {}
        putBack()
      })
      this._after(() => {
        if (moved) unlinkQuiet(aside)
        if (left !== null) this._sweepLater()
        if (old.coverId && old.coverId !== next.coverId) this.dropCoverIfUnused(old.coverId)
        this.onTrackChange(id, 'file')
      })
    })
    return { track: this.tracks.get(id), old }
  }

  // A better file for a track whose original is on the card (or not known now):
  // the new file is committed on internal memory. The old one, of another name,
  // is listed in gone with the change (removed now when the card is ready, at
  // its return otherwise); of the same name, it is a second copy that the next
  // listing of the card settles (the one whose bytes are the track's stays).
  _replaceCardFile (old, next, tmp, oldPlace) {
    const internal = this.places.internal
    this.places.ensureShardSync(internal, 'library', next.id.slice(0, 2))
    const dest = internal.libraryPath(trackFileName(next))
    try {
      renameSyncRetry(tmp, dest)
    } catch (err) {
      throw inUse(err)
    }
    try { fs.chmodSync(dest, 0o644) } catch {}
    const oldName = trackFileName(old)
    const otherName = oldName !== trackFileName(next)
    this.batch(() => {
      const n = this._put(next)
      this._place[n[SLOT]] = CODE.internal
      if (otherName) this._goneAdd(oldName)
      this._onUndo(() => {
        try {
          renameSyncRetry(dest, tmp)
        } catch {}
      })
      this._after(() => {
        const card = this.places.card
        if (card !== null && card.ready) {
          if (otherName) this._sweepGoneCard().catch(() => {})
          else this.places.remove(card, card.libraryPath(oldName)).catch(() => {})
        }
        if (old.coverId && old.coverId !== next.coverId) this.dropCoverIfUnused(old.coverId)
        this.onTrackChange(old.id, 'file')
      })
    })
    return { track: this.tracks.get(old.id), old }
  }

  /**
   * Fill a kept track's metadata from an upload of the same song, as takeTags()
   * says: { changed, stale }. A stale track is looked up again at once, unless
   * `lookup` is false (an archive's entry: the caller asks when it is done).
   */
  fillEmpty (id, meta, { lookup = true } = {}) {
    const t = this.getTrack(id)
    if (t === null) return { changed: false, stale: false }
    const next = { ...t }
    const { changed, stale } = takeTags(next, meta)
    if (!changed) return { changed: false, stale: false }
    this.batch(() => {
      this._put(next)
      this._after(() => {
        this.onTrackChange(id, 'fill')
        if (t.coverId && t.coverId !== next.coverId) this.dropCoverIfUnused(t.coverId)
        if (stale && lookup) this.onStaleLookup(id)
      })
    })
    return { changed, stale }
  }

  /** Has this track (kind 'track') or album (kind 'album', by albumId) a custom cover? */
  hasCustomCover (kind, id) {
    const map = this.customCovers[kind]
    const entry = map ? map.get(id) : undefined
    return entry !== undefined && (entry.small !== null || entry.large !== null)
  }

  // ---------------------------------------------------------- custom covers

  /** { track: { id: { small, large } }, album: {...} } (shared by everyone). */
  coversSnapshot () {
    const out = {}
    for (const [kind, map] of Object.entries(this.customCovers)) {
      const o = {}
      for (const [id, entry] of map) o[id] = { small: entry.small, large: entry.large }
      out[kind] = o
    }
    return out
  }

  checkSharedCoverTarget (kind, id) {
    const valid = Object.prototype.hasOwnProperty.call(SHARED_KINDS, kind) ? SHARED_KINDS[kind] : null
    if (valid === null) throw new HttpError(400, 'Tipo di copertina non valido')
    if (!valid(id)) throw new HttpError(400, 'Identificativo non valido')
  }

  /** Point the `size` slot of a shared custom cover at an image already in covers/. */
  setCustomCover (kind, id, size, coverId) {
    this.checkSharedCoverTarget(kind, id)
    if (!COVER_SIZES.includes(size)) throw new HttpError(400, 'Dimensione non valida')
    if (!isCoverId(coverId)) throw new Error('invalid cover id')
    const entry = this.customCovers[kind].get(id) || { small: null, large: null }
    const previous = entry[size]
    this.batch(() => {
      this._coverPut(kind, id, { small: entry.small, large: entry.large, [size]: coverId })
      if (previous && previous !== coverId) this._after(() => this.dropCoverIfUnused(previous))
    })
  }

  /** Back to the automatic cover. */
  clearCustomCover (kind, id) {
    this.checkSharedCoverTarget(kind, id)
    const entry = this.customCovers[kind].get(id)
    if (!entry) return
    this.batch(() => {
      this._coverDelete(kind, id)
      this._after(() => {
        this.dropCoverIfUnused(entry.small)
        this.dropCoverIfUnused(entry.large)
      })
    })
  }
}

// The changes still to be written after a failed write: what each key needs.
function stripBatch (b) {
  const out = newBatch(false)
  for (const [id, r] of b.tracks) out.tracks.set(id, { existed: r.existed, t: r.t, d: r.d, del: r.del, before: null })
  for (const ck of b.covers) out.covers.add(ck)
  out.g = b.g
  out.s = b.s
  out.z = b.z
  out.x = b.x
  out.p = b.p
  return out
}

function mergeBatches (old, b) {
  const out = stripBatch(old)
  for (const [id, r] of b.tracks) {
    const o = out.tracks.get(id)
    if (o === undefined) out.tracks.set(id, { existed: r.existed, t: r.t, d: r.d, del: r.del, before: null })
    else {
      o.t = o.t || r.t
      o.d = o.d || r.d
      o.del = o.del || r.del
    }
  }
  for (const ck of b.covers) out.covers.add(ck)
  out.g = out.g || b.g
  out.s = out.s || b.s
  out.z = out.z || b.z
  out.x = out.x || b.x
  out.p = out.p || b.p
  return out
}

function bytesOf (bufs) {
  let n = 0
  for (const b of bufs) n += b.length
  return n
}

function runQuietly (fn) {
  try {
    fn()
  } catch (err) {
    logError('library: ' + (err && err.stack ? err.stack : err))
  }
}

function pushCover (covers, ck) {
  const colon = ck.indexOf(':')
  covers[ck.slice(0, colon)].push(ck.slice(colon + 1))
}

function isCode (c) {
  return Number.isInteger(c) && c >= 0 && c < 64
}

function statOrNull (file) {
  try {
    return fs.statSync(file)
  } catch {
    return null
  }
}

function validStat (v) {
  if (!v || typeof v !== 'object' || !Number.isFinite(v.size) || !Number.isFinite(v.mtimeMs)) return null
  return statLine(v)
}

// A stat of db.json as the log keeps it: with the hash of its bytes when known.
function statLine (v) {
  const out = { size: v.size, mtimeMs: v.mtimeMs }
  if (typeof v.hash === 'string' && HASH_RE.test(v.hash)) out.hash = v.hash
  return out
}

function schemaOf (data) {
  return Number.isInteger(data.schema) ? data.schema : 1
}

function sameStat (st, from) {
  return from !== null && st.size === from.size && st.mtimeMs === from.mtimeMs
}

function abortError () {
  const err = new Error('aborted')
  err.name = 'AbortError'
  return err
}

// Until `out` takes more ('drain'); rejects when it closes, fails or `signal` aborts.
function drained (out, signal) {
  if (out.destroyed || out.writableEnded) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const done = (err) => {
      out.off('drain', onDrain)
      out.off('close', onClose)
      out.off('error', onError)
      if (signal !== null) signal.removeEventListener('abort', onAbort)
      if (err) reject(err)
      else resolve()
    }
    const onDrain = () => done(null)
    const onClose = () => done(abortError())
    const onError = (err) => done(err)
    const onAbort = () => done(abortError())
    out.on('drain', onDrain)
    out.on('close', onClose)
    out.on('error', onError)
    if (signal !== null) signal.addEventListener('abort', onAbort, { once: true })
  })
}

// A field filled from another file's tags leaves `tagless` (a fallback, such as
// a title from a file name, does not count).
// Does the track take field k from another file of it (a duplicate, a better
// file)? When the track has none, any value; over one the network filled (and
// nobody edited since), only a real tag of that file.
function takesFrom (t, meta, k) {
  if (isEmptyField(meta, k)) return false
  if (isEmptyField(t, k)) return true
  const name = FILL_FIELDS[k]
  const filled = t.lookup && Array.isArray(t.lookup.filled) ? t.lookup.filled : []
  if (!filled.includes(name) || (Array.isArray(t.edited) && t.edited.includes(name))) return false
  if (Array.isArray(meta.tagless) && meta.tagless.includes(name)) return false
  return meta[k] !== t[k]
}

function fillFrom (t, meta, k) {
  t[k] = meta[k]
  t.tagless = fromTags(t.tagless, meta, k)
  unfill(t, FILL_FIELDS[k])
}

// The field is no longer what the network filled.
function unfill (t, name) {
  if (t.lookup && Array.isArray(t.lookup.filled) && t.lookup.filled.includes(name)) t.lookup = { ...t.lookup, filled: t.lookup.filled.filter((f) => f !== name) }
}

/**
 * Take on `t` (a copy, changed in place) what another file of the track brings.
 * An album that replaces the one the network filled takes that release's details
 * with it: what the network filled from the release and this file has no tag
 * for goes (the album artist becomes the file's own, else the track's artist;
 * year, track, disc and cover empty, still tagless), and the lookup is `stale`:
 * the track is looked up again with its new album. An artist that replaces the
 * network's takes the album artist the network filled along. Edits are never
 * touched. Returns { changed, stale }.
 */
function takeTags (t, meta) {
  let changed = false
  const over = new Set()
  for (const k of Object.keys(FILL_FIELDS)) {
    if (!takesFrom(t, meta, k)) continue
    if (!isEmptyField(t, k)) over.add(k)
    fillFrom(t, meta, k)
    changed = true
  }
  const networks = (k) => {
    const name = FILL_FIELDS[k]
    return t.lookup && Array.isArray(t.lookup.filled) && t.lookup.filled.includes(name) &&
      !(Array.isArray(t.edited) && t.edited.includes(name)) &&
      (isEmptyField(meta, k) || (Array.isArray(meta.tagless) && meta.tagless.includes(name)))
  }
  const drop = (k, value) => {
    t[k] = value
    unfill(t, FILL_FIELDS[k])
    changed = true
  }
  if (over.has('album')) {
    if (networks('albumArtist')) drop('albumArtist', isEmptyField(meta, 'albumArtist') ? t.artist : meta.albumArtist)
    for (const k of ['year', 'trackNo', 'discNo', 'coverId']) if (networks(k)) drop(k, null)
    t.lookup = { ...t.lookup, stale: true }
    return { changed, stale: true }
  }
  if (over.has('artist') && networks('albumArtist')) drop('albumArtist', t.artist)
  return { changed, stale: false }
}

function fromTags (tagless, meta, k) {
  if (!Array.isArray(tagless)) return tagless
  const name = FILL_FIELDS[k]
  if (Array.isArray(meta.tagless) && meta.tagless.includes(name)) return tagless
  return tagless.filter((f) => f !== name)
}

function isEmptyField (t, k) {
  const v = t[k]
  if (v === null || v === undefined || v === '') return true
  if (k === 'artist' || k === 'albumArtist') return v === UNKNOWN_ARTIST
  if (k === 'album') return v === UNKNOWN_ALBUM
  if (k === 'title') return v === t.id
  return false
}

// A file a program holds open (Windows): worth trying again in a moment.
function inUse (err) {
  return isBusy(err) ? new HttpError(409, 'Brano in uso, riprova tra poco') : err
}

// A string field from a request: must be a string, trimmed, control characters
// removed, capped at `max` characters.
function text (value, max) {
  if (typeof value !== 'string') throw new HttpError(400, 'Valore non valido')
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max)
}

function validSignature (fp) {
  return !!fp && typeof fp === 'object' && typeof fp.d === 'number' && Number.isInteger(fp.b) && fp.b >= 0 &&
    typeof fp.s === 'string' && fp.s.length > 0
}

/**
 * The stored track object, with defaults for what older entries lack. Unknown
 * fields are kept. `legacy`: an entry from before profiles, the owner's.
 */
export function normalizeTrack (t, { legacy = false } = {}) {
  return storedTrack(t, legacy, validSignature(t.fp) ? { d: t.fp.d, b: t.fp.b, s: t.fp.s } : null)
}

// normalizeTrack with the signature already decided (`fp`: null when it has none).
function storedTrack (t, legacy, fp) {
  const str = (v, d) => (typeof v === 'string' && v ? v : d)
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const artist = str(t.artist, UNKNOWN_ARTIST)
  const lossless = typeof t.lossless === 'boolean' ? t.lossless : (t.format === 'flac' || t.format === 'wav')
  const out = {
    ...t,
    id: t.id,
    title: str(t.title, t.id),
    artist,
    album: str(t.album, UNKNOWN_ALBUM),
    albumArtist: str(t.albumArtist, artist),
    trackNo: num(t.trackNo),
    discNo: num(t.discNo),
    year: num(t.year),
    duration: num(t.duration),
    format: t.format,
    mime: AUDIO_FORMATS[t.format].mime,
    size: num(t.size) || 0,
    bitrate: num(t.bitrate),
    lossless,
    addedAt: num(t.addedAt) || 0,
    coverId: isCoverId(t.coverId) ? t.coverId : null,
    fileHash: isTrackId(t.fileHash) ? t.fileHash : t.id,
    codec: CODECS.includes(t.codec) ? t.codec : codecOf(t.format, lossless),
    sampleRate: num(t.sampleRate) && t.sampleRate > 0 ? t.sampleRate : null,
    bitDepth: lossless && num(t.bitDepth) && t.bitDepth > 0 ? t.bitDepth : null,
    fakeLossless: typeof t.fakeLossless === 'boolean' && lossless ? t.fakeLossless : null,
    equivKbps: EQUIV_KBPS.includes(t.equivKbps) ? t.equivKbps : null,
    cutoffHz: validCutoff(t.cutoffHz),
    qualityV: Number.isInteger(t.qualityV) && t.qualityV >= 0 ? t.qualityV : 0,
    fp,
    uploaders: Array.isArray(t.uploaders) ? [...new Set(t.uploaders.filter(isUploader))] : (legacy ? ['owner'] : []),
    notSame: Array.isArray(t.notSame) ? [...new Set(t.notSame.filter(isTrackId))] : [],
    fpState: ['ok', 'failed', 'none'].includes(t.fpState) ? t.fpState : 'none',
    tagless: Array.isArray(t.tagless) ? TAGLESS_FIELDS.filter((f) => t.tagless.includes(f)) : null,
    edited: Array.isArray(t.edited) ? EDITABLE_FIELDS.filter((f) => t.edited.includes(f)) : [],
    // null: a track from before the genres, its tags not read for them yet (jobs.mjs)
    genres: Array.isArray(t.genres) ? splitGenres(t.genres) : null,
    sort: validSort(t.sort),
    // the tags' or the measured one (jobs.mjs); null: not known yet
    loud: validLoud(t.loud)
  }
  if (lossless && out.fakeLossless !== true) out.equivKbps = null
  if (out.fakeLossless === true && out.equivKbps === null) out.fakeLossless = null
  if (out.fpState === 'ok' && out.fp === null) out.fpState = 'none'
  if (t.editedUnknown === true) out.editedUnknown = true
  else delete out.editedUnknown
  const lookup = validLookup(t.lookup)
  if (lookup !== null) out.lookup = lookup
  else delete out.lookup
  const genreLookup = validGenreLookup(t.genreLookup)
  if (genreLookup !== null) out.genreLookup = genreLookup
  else delete out.genreLookup
  out.score = scoreOf(out)
  return out
}

// The genres MusicBrainz gave a track whose tags have none (details.mjs): null when not valid.
// The sort tags of a track (media.mjs sortOf): null when none is valid.
const SORT_KEYS = ['artist', 'albumArtist', 'album', 'title']
function validSort (s) {
  if (!s || typeof s !== 'object') return null
  const out = {}
  for (const k of SORT_KEYS) if (typeof s[k] === 'string' && s[k].length > 0 && s[k].length <= 500) out[k] = s[k]
  return Object.keys(out).length > 0 ? out : null
}

function validGenreLookup (g) {
  if (!g || typeof g !== 'object' || g.v !== 1 || (g.state !== 'done' && g.state !== 'failed')) return null
  if (!Number.isFinite(g.at) || !Number.isInteger(g.tries) || g.tries < 1 || !isTrackId(g.fileHash)) return null
  return { v: 1, state: g.state, at: g.at, tries: g.tries, fileHash: g.fileHash, genres: Array.isArray(g.genres) ? splitGenres(g.genres) : [] }
}

function validLookup (l) {
  if (!l || typeof l !== 'object' || l.v !== 1 || !LOOKUP_STATES.includes(l.state)) return null
  if (!Number.isFinite(l.at) || !Number.isInteger(l.tries) || l.tries < 1 || !isTrackId(l.fileHash)) return null
  const id = (v) => (typeof v === 'string' && v.length > 0 && v.length <= 64 ? v : null)
  return {
    v: 1,
    state: l.state,
    at: l.at,
    tries: l.tries,
    fileHash: l.fileHash,
    acoustid: id(l.acoustid),
    recording: id(l.recording),
    release: id(l.release),
    filled: Array.isArray(l.filled) ? TAGLESS_FIELDS.filter((f) => l.filled.includes(f)) : [],
    // Another file of the track changed its album: to look up again.
    ...(l.stale === true ? { stale: true } : {})
  }
}
