// pending/<id>.<ext> and pending/<id>.json: uploads that look like a song the
// library has ("maybe"), waiting for their uploader to choose. Unanswered for
// 24 h, they are decided "both" (nothing is lost; one delete fixes it).
//   { id, profileId, name, file, fileHash, matchTrackId, ber, candidate,
//     archiveId, createdAt, expiresAt } (+ the raw fingerprint and the role)

import fs from 'node:fs'
import path from 'node:path'
import { apiError } from './errors.mjs'
import { isJobId } from './ids.mjs'
import { packItems, unpackItems } from './fingerprint.mjs'
import { ensureDir, writeJsonAtomicSync, readJsonFile, unlinkQuiet, renameSyncRetry, newId16 } from './util.mjs'

export const PENDING_TTL = 24 * 60 * 60 * 1000
const EXT_RE = /^(mp3|aac|m4a|flac|ogg|opus|wav)$/

export class PendingStore {
  constructor ({ dataDir, ttlMs = PENDING_TTL }) {
    this.dir = path.join(path.resolve(dataDir), 'pending')
    this.ttlMs = ttlMs
    this._recs = new Map()
  }

  load () {
    ensureDir(this.dir)
    const names = fs.readdirSync(this.dir)
    for (const name of names) {
      const m = /^([0-9a-f]{16})\.json$/.exec(name)
      if (m === null) continue
      const rec = readJsonFile(path.join(this.dir, name))
      if (!rec || rec.id !== m[1] || !EXT_RE.test(String(rec.ext)) || !fs.existsSync(this.filePath(rec))) {
        this._dropFiles(m[1], rec)
        continue
      }
      this._recs.set(rec.id, rec)
    }
    // Files without their record (a crash between the two writes).
    for (const name of names) {
      const m = /^([0-9a-f]{16})\.(mp3|aac|m4a|flac|ogg|opus|wav|tmp)$/.exec(name)
      if (m !== null && !this._recs.has(m[1])) unlinkQuiet(path.join(this.dir, name))
    }
  }

  filePath (rec) {
    if (!isJobId(rec.id) || !EXT_RE.test(String(rec.ext))) throw new Error('invalid pending record')
    return path.join(this.dir, rec.id + '.' + rec.ext)
  }

  _jsonPath (id) {
    return path.join(this.dir, id + '.json')
  }

  /** Park an upload: its file moves to pending/. Returns the record (fp unpacked). */
  async add ({ file, ext, profileId, name, fileHash, matchTrackId, ber, candidate, archiveId, fp, role }) {
    ensureDir(this.dir)
    const now = Date.now()
    const rec = {
      id: newId16(),
      profileId,
      name,
      file: '',
      ext,
      fileHash,
      matchTrackId,
      ber,
      candidate,
      archiveId: archiveId || null,
      role,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      fp: fp ? { duration: fp.duration, items: packItems(fp.items).toString('base64') } : null
    }
    rec.file = path.basename(this.filePath(rec))
    renameSyncRetry(file, this.filePath(rec))
    writeJsonAtomicSync(this._jsonPath(rec.id), rec)
    this._recs.set(rec.id, rec)
    return this._view(rec)
  }

  _view (rec) {
    return { ...rec, fp: rec.fp ? { duration: rec.fp.duration, items: unpackItems(Buffer.from(rec.fp.items, 'base64')) } : null }
  }

  /** The caller's own pending upload, or 404 pending_gone. */
  get (actor, id) {
    const rec = isJobId(id) ? this._recs.get(id) : undefined
    if (!rec || rec.profileId !== actor) throw apiError('pending_gone')
    return this._view(rec)
  }

  byId (id) {
    const rec = this._recs.get(id)
    return rec ? this._view(rec) : null
  }

  /** Being decided: no other answer may take it. */
  take (id) {
    const rec = this._recs.get(id)
    if (!rec || rec.taken) return false
    rec.taken = true
    return true
  }

  /** The record is gone (its file was consumed by the decision). */
  forget (id) {
    const rec = this._recs.get(id)
    this._recs.delete(id)
    unlinkQuiet(this._jsonPath(id))
    if (rec) unlinkQuiet(this.filePath(rec))
  }

  _dropFiles (id, rec) {
    unlinkQuiet(this._jsonPath(id))
    if (rec && EXT_RE.test(String(rec.ext))) unlinkQuiet(path.join(this.dir, id + '.' + rec.ext))
  }

  /** Records whose 24 h are over. */
  expired (now = Date.now()) {
    return [...this._recs.values()].filter((r) => !r.taken && r.expiresAt <= now).map((r) => this._view(r))
  }

  all () {
    return [...this._recs.values()].map((r) => this._view(r))
  }

  /** The owner's literal "owner" (or a wrong first owner) becomes a profile. */
  replaceProfile (from, to) {
    for (const rec of this._recs.values()) {
      if (rec.profileId !== from) continue
      rec.profileId = to
      writeJsonAtomicSync(this._jsonPath(rec.id), rec)
    }
  }

  /** A removed profile: its parked uploads go. */
  dropProfile (profileId) {
    for (const rec of [...this._recs.values()]) if (rec.profileId === profileId && !rec.taken) this.forget(rec.id)
  }
}
