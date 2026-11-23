// Archives (ZIP, 7z, RAR) uploaded as one file and extracted on the source, one
// at a time; others wait "queued". archives/<id>.json holds the status:
//   { id, name, state: queued|checking|extracting|importing|done|failed, total,
//     done, added, replaced, duplicates, ignored, pending: [], trackIds: [],
//     coverId, error, code, createdAt, finishedAt } (+ profileId)
// The archive itself is tmp/a-<id>.<ext>, its extraction dir tmp/x-<id>/; both are
// removed in every case. Every audio entry then runs the upload pipeline in
// listing order; an X.lrc in the same folder as X.<audio> (the same base name, in
// any case) gives that track its lyrics when its tags gave no synced ones. A
// status is kept 24 h after it finished.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ArchiveError, ARCHIVE_ERRORS, HttpError } from './errors.mjs'
import { isJobId } from './ids.mjs'
import { saveCoverBytes, MAX_COVER_BYTES } from './media.mjs'
import { MAX_LYRICS_BYTES } from './lrc.mjs'
import { judgeListing } from './sevenzip.mjs'
import { ZipArchive } from './zip.mjs'
import { ensureDir, writeJsonAtomicSync, readJsonFile, unlinkQuiet, removeTree, renameSyncRetry, newId16, log, logError } from './util.mjs'

const KEEP_MS = 24 * 60 * 60 * 1000
const AUDIO_EXT = new Set(['mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wav'])
const ARCHIVE_EXT = new Set(['zip', '7z', 'rar'])
const COVER_NAMES = new Set(['cover', 'folder', 'front'])
const FINAL = new Set(['done', 'failed'])
// The .lrc texts of entries waiting for their uploader's choice (in memory: a
// restart loses them, the choice itself is kept).
const MAX_PENDING_LYRICS = 200

function extOf (name) {
  const base = baseName(name)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

function baseName (name) {
  return String(name).split(/[\\/]/).pop()
}

function stemOf (name) {
  const base = baseName(name)
  const dot = base.lastIndexOf('.')
  return (dot > 0 ? base.slice(0, dot) : base).toLowerCase()
}

// An entry's folder and base name without extension, in lower case: an audio and
// its .lrc share it.
function besideKey (name) {
  const parts = String(name).split(/[\\/]/)
  parts.pop()
  return parts.join('/').toLowerCase() + '\u0000' + stemOf(name)
}

/** Status as the uploader sees it (GET /api/archives/:id). */
function publicStatus (rec, pendingView) {
  return {
    id: rec.id,
    name: rec.name,
    state: rec.state,
    total: rec.total,
    done: rec.done,
    added: rec.added,
    replaced: rec.replaced,
    duplicates: rec.duplicates,
    ignored: rec.ignored,
    pending: rec.pending.map(pendingView).filter(Boolean),
    trackIds: rec.trackIds,
    coverId: rec.coverId,
    error: rec.error,
    code: rec.code,
    createdAt: rec.createdAt,
    finishedAt: rec.finishedAt
  }
}

export class Archives {
  /**
   * @param {object} deps
   * @param {string} deps.dataDir
   * @param {import('./library.mjs').Library} deps.library
   * @param {import('./disk.mjs').Disk} deps.disk
   * @param {import('./sevenzip.mjs').SevenZip} deps.sevenZip
   * @param {() => import('./pipeline.mjs').Pipeline} deps.pipeline
   * @param {(pendingId: string) => boolean} [deps.pendingExists]
   * @param {(trackId: string) => void} [deps.lookup]  queue a details lookup of an imported track
   * @param {{ beside(trackId, text): boolean }|null} [deps.lyrics]  takes an .lrc found beside an audio
   */
  constructor ({ dataDir, library, disk, sevenZip, pipeline, jobs = null, keepMs = KEEP_MS, watch = {}, pendingExists = () => true, lookup = () => {}, lyrics = null }) {
    this.dir = path.join(path.resolve(dataDir), 'archives')
    this.tmpDir = library.tmpDir
    this.library = library
    this.disk = disk
    this.sevenZip = sevenZip
    this.pipeline = pipeline
    this.jobs = jobs
    this.keepMs = keepMs
    this.watch = watch // watchdog timings (tests)
    this.pendingExists = pendingExists
    this.lookup = lookup
    this.lyrics = lyrics
    this._besides = new Map() // pending id -> the text of its .lrc
    this._recs = new Map()
    this._queue = []
    this._running = null
    this._closed = false
    this._idleWaiters = []
  }

  load () {
    ensureDir(this.dir)
    const now = Date.now()
    for (const name of fs.readdirSync(this.dir)) {
      const m = /^([0-9a-f]{16})\.json$/.exec(name)
      if (m === null) {
        if (name.endsWith('.tmp')) unlinkQuiet(path.join(this.dir, name))
        continue
      }
      const rec = readJsonFile(path.join(this.dir, name))
      if (!rec || rec.id !== m[1]) {
        unlinkQuiet(path.join(this.dir, name))
        continue
      }
      rec.pending = Array.isArray(rec.pending) ? rec.pending.filter((id) => this.pendingExists(id)) : []
      rec.trackIds = Array.isArray(rec.trackIds) ? rec.trackIds : []
      if (!FINAL.has(rec.state)) {
        // Cut by a restart: its files in tmp/ are gone already.
        this._fail(rec, 'archive_interrupted', now)
      }
      if (rec.finishedAt && now - rec.finishedAt > this.keepMs && rec.pending.length === 0) {
        unlinkQuiet(path.join(this.dir, name))
        continue
      }
      this._recs.set(rec.id, rec)
    }
  }

  _save (rec) {
    writeJsonAtomicSync(path.join(this.dir, rec.id + '.json'), rec)
  }

  _fail (rec, code, now = Date.now()) {
    rec.state = 'failed'
    rec.code = code in ARCHIVE_ERRORS ? code : 'archive_invalid'
    rec.error = ARCHIVE_ERRORS[rec.code]
    rec.finishedAt = now
    this._save(rec)
  }

  /** Bytes the archives at work will still write (their listed totals). */
  reservedBytes () {
    let sum = 0
    for (const rec of this._recs.values()) {
      if (rec.state === 'queued' || rec.state === 'checking' || rec.state === 'extracting') sum += rec.reserve || 0
    }
    return sum
  }

  /**
   * A new archive: the file moves to tmp/a-<id>.<kind> and waits its turn.
   * Returns its id.
   */
  async start ({ file, kind, name, caller }) {
    if (kind !== 'zip' && !this.sevenZip.supports(kind)) {
      throw new HttpError(415, 'Formato non supportato', 'unsupported_archive')
    }
    const id = newId16()
    const now = Date.now()
    const rec = {
      id,
      name: baseName(name || 'archivio'),
      state: 'queued',
      total: 0,
      done: 0,
      added: 0,
      replaced: 0,
      duplicates: 0,
      ignored: 0,
      pending: [],
      trackIds: [],
      coverId: null,
      error: null,
      code: null,
      createdAt: now,
      finishedAt: null,
      profileId: caller.actor,
      kind,
      ask: caller.ask === true,
      role: caller.role,
      reserve: 0
    }
    renameSyncRetry(file, this._archiveFile(rec))
    this._recs.set(id, rec)
    this._save(rec)
    this._queue.push(id)
    this._pump()
    return id
  }

  _archiveFile (rec) {
    return path.join(this.tmpDir, 'a-' + rec.id + '.' + rec.kind)
  }

  _extractDir (rec) {
    return path.join(this.tmpDir, 'x-' + rec.id)
  }

  /** The caller's archive status, or 404. */
  get (actor, id, pendingView) {
    const rec = isJobId(id) ? this._recs.get(id) : undefined
    if (!rec || rec.profileId !== actor) throw new HttpError(404, 'Archivio non trovato')
    return publicStatus(rec, pendingView)
  }

  record (id) {
    return this._recs.get(id) || null
  }

  _pump () {
    if (this._running !== null || this._closed) return
    const id = this._queue.shift()
    if (id === undefined) {
      const waiters = this._idleWaiters
      this._idleWaiters = []
      for (const resolve of waiters) resolve()
      return
    }
    const rec = this._recs.get(id)
    if (!rec || rec.state !== 'queued') {
      setImmediate(() => this._pump())
      return
    }
    this._running = rec
    this._process(rec)
      .catch((err) => logError('archive ' + rec.id + ' crashed: ' + (err && err.stack ? err.stack : err)))
      .finally(() => {
        removeTree(this._extractDir(rec))
        unlinkQuiet(this._archiveFile(rec))
        rec.reserve = 0
        if (rec.dropped) this._forget(rec)
        this._running = null
        setImmediate(() => this._pump())
      })
  }

  /** Resolves when no archive waits or runs (tests). */
  idle () {
    if (this._running === null && this._queue.length === 0) return Promise.resolve()
    return new Promise((resolve) => this._idleWaiters.push(resolve))
  }

  async _process (rec) {
    const file = this._archiveFile(rec)
    const dir = this._extractDir(rec)
    let entries
    let zip = null
    try {
      rec.state = 'checking'
      this._save(rec)
      const archiveSize = fs.statSync(file).size
      let names
      if (rec.kind === 'zip') {
        zip = new ZipArchive(file)
        const checked = await zip.check()
        rec.total = 0
        rec.reserve = checked.total
        names = checked.names
      } else {
        const listing = await this.sevenZip.list(file)
        const judged = judgeListing(listing, archiveSize)
        rec.reserve = judged.total
        names = judged.files.map((f) => f.name)
      }
      // The listed total must fit (it is not reserved yet while we ask).
      const reserve = rec.reserve
      rec.reserve = 0
      try {
        await this.disk.check(reserve)
      } catch {
        throw new ArchiveError('disk_full')
      }
      rec.reserve = reserve
      rec.total = names.filter((n) => AUDIO_EXT.has(extOf(n))).length
      rec.state = 'extracting'
      this._save(rec)
      ensureDir(dir)
      if (zip !== null) {
        entries = await zip.extract(dir, this.watch)
      } else {
        await this.sevenZip.extract(file, dir, rec.reserve, this.watch)
        entries = mapExtracted(dir, names)
      }
    } catch (err) {
      if (zip !== null) zip.close()
      const code = err instanceof ArchiveError ? err.code : (err && err.code === 'ENOSPC' ? 'disk_full' : 'archive_invalid')
      if (!(err instanceof ArchiveError)) logError('archive ' + rec.id + ' failed: ' + (err && err.message))
      this._fail(rec, code)
      return
    }
    if (zip !== null) zip.close()
    unlinkQuiet(file)

    rec.state = 'importing'
    rec.reserve = 0
    this._save(rec)
    const caller = { actor: rec.profileId, role: rec.role, ask: rec.ask }
    // The .lrc files, by folder and name: each stays until its audio is in.
    const lrcs = new Map()
    for (const entry of entries) if (extOf(entry.name) === 'lrc') lrcs.set(besideKey(entry.name), entry.file)
    let coverDone = false
    for (const entry of entries) {
      if (this._closed || rec.dropped) return
      const ext = extOf(entry.name)
      if (!coverDone && COVER_NAMES.has(stemOf(entry.name))) {
        const coverId = readCover(entry.file, this.library.coversDir)
        if (coverId !== null) {
          rec.coverId = coverId
          coverDone = true
        }
      }
      if (ARCHIVE_EXT.has(ext)) {
        rec.ignored++
        unlinkQuiet(entry.file)
        continue
      }
      if (!AUDIO_EXT.has(ext)) {
        if (ext !== 'lrc') unlinkQuiet(entry.file)
        continue
      }
      const result = await this._importEntry(rec, entry, caller)
      const lrc = lrcs.get(besideKey(entry.name))
      if (lrc !== undefined && result !== null) this._lyricsBeside(result, lrc)
      rec.done++
      this._save(rec)
    }
    if (rec.coverId !== null) this._applyCover(rec)
    rec.state = 'done'
    rec.finishedAt = Date.now()
    this._save(rec)
    // Its tracks' details, now that the archive's cover counts.
    for (const id of rec.trackIds) this.lookup(id)
    log('archive ' + rec.name + ': ' + rec.added + ' added, ' + rec.replaced + ' replaced, ' + rec.duplicates + ' already there, ' + rec.ignored + ' ignored, ' + rec.pending.length + ' to choose')
  }

  async _importEntry (rec, entry, caller) {
    let st
    try {
      st = fs.lstatSync(entry.file)
    } catch {
      rec.ignored++
      return
    }
    if (!st.isFile()) {
      rec.ignored++
      return
    }
    try {
      // Its bytes reach the disk before db.json can name it as a track.
      const fd = fs.openSync(entry.file, 'r+')
      try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      const hash = await hashFile(entry.file)
      const result = await this.pipeline().ingest({ file: entry.file, hash, size: st.size, name: baseName(entry.name), caller, archiveId: rec.id })
      this.count(rec, result)
      return result
    } catch (err) {
      unlinkQuiet(entry.file)
      rec.ignored++
      if (!(err instanceof HttpError)) logError('archive entry ' + baseName(entry.name) + ' failed: ' + (err && err.message))
    }
    return null
  }

  // An .lrc beside an imported audio: to its track (kept only when it has no
  // synced lyrics); for an entry waiting for a choice, once it is decided.
  _lyricsBeside (result, file) {
    if (this.lyrics === null) return
    const text = readLrc(file)
    if (text === null) return
    if (result.outcome === 'maybe' && result.pending) {
      if (this._besides.size < MAX_PENDING_LYRICS) this._besides.set(result.pending.id, text)
      return
    }
    if (result.trackId) this.lyrics.beside(result.trackId, text)
  }

  /** Add one entry's result to an archive's counts. */
  count (rec, result) {
    switch (result.outcome) {
      case 'added': rec.added++; break
      case 'replaced': rec.replaced++; break
      case 'duplicate': rec.duplicates++; break
      case 'maybe': rec.pending.push(result.pending.id); return
      default: rec.ignored++; return
    }
    if (result.trackId && !rec.trackIds.includes(result.trackId)) rec.trackIds.push(result.trackId)
  }

  /** A parked entry was answered (or expired): out of `pending`, into the counts. */
  resolvePending (archiveId, pendingId, result) {
    const rec = this._recs.get(archiveId)
    if (!rec) return
    rec.pending = rec.pending.filter((id) => id !== pendingId)
    const text = this._besides.get(pendingId)
    this._besides.delete(pendingId)
    if (text !== undefined && result.trackId && this.lyrics !== null) this.lyrics.beside(result.trackId, text)
    this.count(rec, result)
    if (rec.coverId !== null) this._applyCover(rec)
    this._save(rec)
  }

  /** Is this archive still importing its entries? */
  importing (archiveId) {
    const rec = this._recs.get(archiveId)
    return rec !== undefined && rec.state !== 'done' && rec.state !== 'failed'
  }

  // The archive's cover image becomes the embedded cover of its tracks that have none.
  _applyCover (rec) {
    if (!this.library.coverExists(rec.coverId)) return
    let changed = false
    try {
      changed = this.library.applyArchiveCover(rec.trackIds, rec.coverId)
    } catch (err) {
      logError('archive ' + rec.id + ': its cover not applied: ' + err.message)
    }
    if (changed) {
      if (this.jobs !== null) this.jobs.requestCoverSizes(rec.coverId, 1)
    } else {
      this.library.dropCoverIfUnused(rec.coverId)
    }
  }

  /**
   * A removed profile: its archives go. The one being extracted or imported
   * stops at its next entry; nothing more of it reaches the library.
   */
  dropProfile (profileId) {
    for (const rec of [...this._recs.values()]) {
      if (rec.profileId !== profileId) continue
      rec.dropped = true
      if (rec === this._running) continue
      this._queue = this._queue.filter((id) => id !== rec.id)
      unlinkQuiet(this._archiveFile(rec))
      this._forget(rec)
    }
  }

  _forget (rec) {
    this._recs.delete(rec.id)
    unlinkQuiet(path.join(this.dir, rec.id + '.json'))
  }

  replaceProfile (from, to) {
    for (const rec of this._recs.values()) {
      if (rec.profileId !== from) continue
      rec.profileId = to
      this._save(rec)
    }
  }

  /** Statuses kept 24 h after they finished (pending answers keep them longer). */
  sweep (now = Date.now()) {
    for (const rec of [...this._recs.values()]) {
      // A choice whose record went without an answer (its file vanished) holds nothing.
      const pending = rec.pending.filter((id) => this.pendingExists(id))
      if (pending.length !== rec.pending.length) {
        rec.pending = pending
        this._save(rec)
      }
      if (rec.finishedAt && now - rec.finishedAt > this.keepMs && rec.pending.length === 0) this._forget(rec)
    }
  }

  close () {
    this._closed = true
    this._queue = []
    const waiters = this._idleWaiters
    this._idleWaiters = []
    for (const resolve of waiters) resolve()
  }
}

/**
 * Files 7-Zip extracted flat, in listing order: each listed base name, the
 * k-th repeat of a name renamed by -aou to name_k.ext; anything left over after.
 */
export function mapExtracted (dir, names) {
  let present
  try {
    present = new Set(fs.readdirSync(dir))
  } catch {
    present = new Set()
  }
  const seen = new Map()
  const out = []
  for (const name of names) {
    const base = baseName(name)
    const n = seen.get(base) || 0
    seen.set(base, n + 1)
    let candidate = base
    if (n > 0) {
      const dot = base.lastIndexOf('.')
      candidate = dot > 0 ? base.slice(0, dot) + '_' + n + base.slice(dot) : base + '_' + n
    }
    if (present.has(candidate)) {
      present.delete(candidate)
      out.push({ name, file: path.join(dir, candidate) })
    }
  }
  for (const rest of [...present].sort()) out.push({ name: rest, file: path.join(dir, rest) })
  return out
}

// The text of an .lrc entry (UTF-8, at most 64 KB), or null.
function readLrc (file) {
  try {
    const st = fs.lstatSync(file)
    if (!st.isFile() || st.size > MAX_LYRICS_BYTES) return null
    return new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file))
  } catch {
    return null
  }
}

function readCover (file, coversDir) {
  try {
    const st = fs.lstatSync(file)
    if (!st.isFile() || st.size > MAX_COVER_BYTES) return null
    return saveCoverBytes(fs.readFileSync(file), coversDir)
  } catch {
    return null
  }
}

async function hashFile (file) {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex').slice(0, 24)
}
