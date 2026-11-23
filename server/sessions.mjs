// Resumable uploads (files over 32 MB, up to 600 MiB of audio or 4 GiB of
// archive): uploads/<id>.part and uploads/<id>.json.
//   { id, profileId, clientKey, name, size, lastModified, headHash,
//     kind: audio|archive, offset, createdAt, updatedAt, done, result, error }
// A chunk is written at the stored offset (the .part opened r+, truncated to the
// offset first, never appended), fsynced before the .json moves on: after an
// interrupted request the offset is what reached the disk. One writer per
// session: a newer PUT destroys the open one and waits for it to settle. A
// running SHA-256 follows the bytes, so the file is never read again for its id
// (after a restart the prefix is hashed once, at the next chunk). The last chunk
// starts the pipeline, which runs to the end whatever happens to the request.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { HttpError, apiError, stateError } from './errors.mjs'
import { isJobId, cleanUploadName } from './ids.mjs'
import { archiveKindOf, readHead } from './pipeline.mjs'
import { MAX_UPLOAD_BYTES, MAX_ARCHIVE_BYTES, tooLargeError } from './upload.mjs'
import { ensureDir, writeJsonAtomicSync, readJsonFile, unlinkQuiet, Mutex, newId16, logError } from './util.mjs'

export const CHUNK_BYTES = 8388608
export const MAX_CHUNK_BYTES = 16777216
const HOUR = 60 * 60 * 1000
const UNFINISHED_TTL = 24 * HOUR
const FINISHED_TTL = HOUR
const IDLE_MS = HOUR
const PER_PROFILE = 4
const MEMBERS_TOTAL = 16

/** 'audio' or the archive kind ('zip', '7z', 'rar') a file name stands for. */
export function sessionKindOf (name) {
  const m = /\.(zip|7z|rar)$/i.exec(name)
  return m ? m[1].toLowerCase() : 'audio'
}

export class UploadSessions {
  /**
   * @param {object} deps
   * @param {string} deps.dataDir
   * @param {import('./disk.mjs').Disk} deps.disk
   * @param {import('./sevenzip.mjs').SevenZip} deps.sevenZip
   * @param {(actor: string) => boolean} deps.isOwner
   * @param {(rec, file, hash) => Promise<object>} deps.finish  runs the pipeline, resolves the rendered result
   */
  constructor ({ dataDir, disk, sevenZip, isOwner, finish, now = () => Date.now() }) {
    this.dir = path.join(path.resolve(dataDir), 'uploads')
    this.disk = disk
    this.sevenZip = sevenZip
    this.isOwner = isOwner
    this.finish = finish
    this.now = now
    this._s = new Map() // id -> { rec, hash, hashedTo, lock, gen, current, processing, pipeline, cancelled }
  }

  /** Read uploads/; returns the ids whose pipeline was cut by a restart. */
  load () {
    ensureDir(this.dir)
    const now = this.now()
    const rerun = []
    const names = fs.readdirSync(this.dir)
    for (const name of names) {
      const m = /^([0-9a-f]{16})\.json$/.exec(name)
      if (m === null) continue
      const rec = readJsonFile(path.join(this.dir, name))
      if (!rec || rec.id !== m[1] || !Number.isSafeInteger(rec.size) || !Number.isSafeInteger(rec.offset)) {
        this._removeFiles(m[1])
        continue
      }
      const s = this._wrap(rec)
      if (rec.done) {
        if (now - (rec.finishedAt || rec.updatedAt) > FINISHED_TTL) {
          this._removeFiles(rec.id)
          continue
        }
      } else if (now - rec.updatedAt > UNFINISHED_TTL) {
        this._removeFiles(rec.id)
        continue
      } else {
        // The bytes on disk are the truth: a .part shorter than the record (a
        // crash before the fsync) or longer (after it) is cut to agree.
        let st = null
        try { st = fs.statSync(this._part(rec.id)) } catch {}
        if (st === null) {
          this._removeFiles(rec.id)
          continue
        }
        if (st.size < rec.offset) {
          rec.offset = st.size
          this._save(rec)
        }
        if (rec.offset === rec.size) rerun.push(rec.id)
      }
      this._s.set(rec.id, s)
    }
    for (const name of names) {
      const m = /^([0-9a-f]{16})\.part$/.exec(name)
      if (m !== null && !this._s.has(m[1])) unlinkQuiet(path.join(this.dir, name))
    }
    return rerun
  }

  _wrap (rec) {
    return { rec, hash: null, hashedTo: -1, lock: new Mutex(), gen: 0, current: null, processing: false, pipeline: null, cancelled: false }
  }

  _part (id) {
    return path.join(this.dir, id + '.part')
  }

  _json (id) {
    return path.join(this.dir, id + '.json')
  }

  _save (rec) {
    writeJsonAtomicSync(this._json(rec.id), rec)
  }

  _removeFiles (id) {
    unlinkQuiet(this._json(id))
    unlinkQuiet(this._part(id))
  }

  /** What the unfinished sessions (but `exclude`) still have to send. */
  reservedBytes (exclude = null) {
    let sum = 0
    for (const s of this._s.values()) {
      if (s.rec.done || s.rec.id === exclude) continue
      sum += Math.max(0, s.rec.size - s.rec.offset)
    }
    return sum
  }

  _expiresAt (rec) {
    return rec.done ? (rec.finishedAt || rec.updatedAt) + FINISHED_TTL : rec.updatedAt + UNFINISHED_TTL
  }

  /** GET /api/uploads/:id */
  view (s) {
    const rec = s.rec
    const out = { id: rec.id, name: rec.name, size: rec.size, offset: rec.offset, processing: s.processing, expiresAt: this._expiresAt(rec), done: rec.done }
    if (rec.done && rec.result) out.result = rec.result
    if (rec.done && rec.error) out.error = rec.error
    return out
  }

  _own (caller, id) {
    const s = isJobId(id) ? this._s.get(id) : undefined
    if (!s || s.rec.profileId !== caller.actor || s.cancelled) throw apiError('session_gone')
    return s
  }

  get (caller, id) {
    return this.view(this._own(caller, id))
  }

  list (caller) {
    const out = []
    for (const s of this._s.values()) {
      const r = s.rec
      if (r.profileId !== caller.actor || r.done || s.cancelled) continue
      out.push({ id: r.id, name: r.name, size: r.size, lastModified: r.lastModified, offset: r.offset, updatedAt: r.updatedAt })
    }
    return { sessions: out }
  }

  /** POST /api/uploads: { status, body }. */
  async create (caller, body) {
    const name = typeof body.name === 'string' ? cleanUploadName(body.name) : ''
    const { size, lastModified, headHash } = body
    if (!name) throw new HttpError(400, 'Nome del file non valido')
    if (!Number.isSafeInteger(size) || size <= 0) throw new HttpError(400, 'Dimensione non valida')
    if (typeof lastModified !== 'number' || !Number.isFinite(lastModified)) throw new HttpError(400, 'Data del file non valida')
    if (typeof headHash !== 'string' || !/^[0-9a-f]{64}$/.test(headHash)) throw new HttpError(400, 'Impronta del file non valida')
    const kind = sessionKindOf(name)
    const limit = kind === 'audio' ? MAX_UPLOAD_BYTES : MAX_ARCHIVE_BYTES
    if (size > limit) throw tooLargeError(limit)
    if ((kind === '7z' || kind === 'rar') && !this.sevenZip.supports(kind)) throw apiError('unsupported_archive')

    for (const s of this._s.values()) {
      const r = s.rec
      if (!r.done && !s.cancelled && r.profileId === caller.actor && r.name === name && r.size === size &&
          r.lastModified === lastModified && r.headHash === headHash) {
        return { status: 200, body: this._answer(r) }
      }
    }

    await this.disk.check(size)
    const now = this.now()
    const mine = this._unfinished((r) => r.profileId === caller.actor)
    if (mine.length >= PER_PROFILE && !this._cancelIdle(mine, now)) throw apiError('too_many_uploads')
    if (!this.isOwner(caller.actor)) {
      const members = this._unfinished((r) => !this.isOwner(r.profileId))
      if (members.length >= MEMBERS_TOTAL && !this._cancelIdle(members, now)) throw apiError('too_many_uploads')
    }

    ensureDir(this.dir)
    const rec = {
      id: newId16(),
      profileId: caller.actor,
      clientKey: caller.clientKey || null,
      name,
      size,
      lastModified,
      headHash,
      kind: kind === 'audio' ? 'audio' : 'archive',
      offset: 0,
      createdAt: now,
      updatedAt: now,
      done: false,
      result: null,
      error: null,
      ask: caller.ask === true,
      role: caller.role
    }
    fs.writeFileSync(this._part(rec.id), Buffer.alloc(0), { mode: 0o600 })
    this._save(rec)
    const s = this._wrap(rec)
    s.hash = crypto.createHash('sha256')
    s.hashedTo = 0
    this._s.set(rec.id, s)
    return { status: 201, body: this._answer(rec) }
  }

  _answer (rec) {
    return { id: rec.id, size: rec.size, offset: rec.offset, chunkBytes: CHUNK_BYTES, expiresAt: this._expiresAt(rec) }
  }

  _unfinished (filter) {
    return [...this._s.values()].filter((s) => !s.rec.done && !s.cancelled && filter(s.rec))
  }

  // The oldest session with no chunk for an hour gives its slot.
  _cancelIdle (list, now) {
    const idle = list.filter((s) => !s.processing && s.current === null && now - s.rec.updatedAt >= IDLE_MS)
      .sort((a, b) => a.rec.updatedAt - b.rec.updatedAt)
    if (idle.length === 0) return false
    this._drop(idle[0])
    return true
  }

  _drop (s) {
    s.cancelled = true
    this._s.delete(s.rec.id)
    unlinkQuiet(this._json(s.rec.id))
    // A pipeline at work consumes the .part itself.
    if (!s.processing) unlinkQuiet(this._part(s.rec.id))
    if (s.current) s.current.destroy()
  }

  /** DELETE /api/uploads/:id */
  cancel (caller, id) {
    this._drop(this._own(caller, id))
  }

  _mismatch (s) {
    return stateError('offset_mismatch', this.view(s))
  }

  /**
   * PUT /api/uploads/:id?offset=n. Resolves the answer, or null when this
   * request was taken over by a newer one (it is destroyed, nothing to send).
   */
  async put (req, caller, id, offsetParam) {
    const s = this._own(caller, id)
    // Every byte is in: answer with the state at once, never touch the request
    // waiting for the pipeline.
    if (s.processing || s.rec.done) {
      req.resume()
      throw this._mismatch(s)
    }
    const gen = ++s.gen
    if (s.current !== null) s.current.destroy()
    return s.lock.run(async () => {
      if (gen !== s.gen || s.cancelled) {
        req.destroy()
        return null
      }
      s.current = req
      try {
        return await this._write(s, req, offsetParam)
      } finally {
        if (s.current === req) s.current = null
      }
    })
  }

  async _write (s, req, offsetParam) {
    const rec = s.rec
    if (s.processing || rec.done) throw this._mismatch(s)
    if (!/^\d+$/.test(String(offsetParam))) throw new HttpError(400, 'Posizione non valida')
    const n = Number(offsetParam)
    if (n !== rec.offset) throw this._mismatch(s)
    const declared = req.headers['content-length']
    if (declared === undefined || !/^\d+$/.test(declared)) throw new HttpError(411, 'Lunghezza mancante')
    const len = Number(declared)
    if (len > MAX_CHUNK_BYTES) throw new HttpError(413, 'Richiesta troppo grande')
    if (n + len > rec.size) throw new HttpError(400, 'Dati oltre la fine del file')
    await this.disk.check(len, rec.id)
    if (s.hashedTo !== rec.offset) await this._rehash(s)

    const fh = await fs.promises.open(this._part(rec.id), 'r+')
    let pos = rec.offset
    let failure = null
    try {
      await fh.truncate(rec.offset)
      for await (const chunk of req) {
        if (pos + chunk.length > rec.offset + len) throw new HttpError(400, 'Dati oltre la fine del file')
        let done = 0
        while (done < chunk.length) {
          const { bytesWritten } = await fh.write(chunk, done, chunk.length - done, pos + done)
          done += bytesWritten
        }
        s.hash.update(chunk)
        pos += chunk.length
        s.hashedTo = pos
      }
    } catch (err) {
      failure = err
    } finally {
      try { await fh.sync() } catch {}
      await fh.close().catch(() => {})
    }
    if (pos !== rec.offset) {
      rec.offset = pos
      rec.updatedAt = this.now()
      this._save(rec)
    }
    if (failure !== null || pos - n !== len) {
      if (failure && failure.code === 'ENOSPC') throw apiError('disk_full')
      if (failure instanceof HttpError) throw failure
      if (req.destroyed) return null // cut, or taken over by a newer request
      throw new HttpError(400, 'Caricamento interrotto')
    }
    if (rec.offset < rec.size) return { offset: rec.offset }
    return this._complete(s)
  }

  async _rehash (s) {
    const hash = crypto.createHash('sha256')
    const end = s.rec.offset
    if (end > 0) {
      for await (const chunk of fs.createReadStream(this._part(s.rec.id), { start: 0, end: end - 1 })) hash.update(chunk)
    }
    s.hash = hash
    s.hashedTo = end
  }

  /** Every byte is there: check, then the pipeline. */
  async _complete (s) {
    const rec = s.rec
    s.processing = true
    s.pipeline = this._runPipeline(s)
    await s.pipeline
    if (rec.error) throw new HttpError(rec.error.status, rec.error.error, rec.error.code)
    return { offset: rec.offset, done: true, result: rec.result }
  }

  async _runPipeline (s) {
    const rec = s.rec
    try {
      if (s.hash === null || s.hashedTo !== rec.size) await this._rehash(s)
      const file = this._part(rec.id)
      if (rec.kind === 'archive') {
        const want = sessionKindOf(rec.name)
        if (archiveKindOf(await readHead(file, 16)) !== want) throw apiError('unsupported_archive')
      }
      const hash = s.hash.digest('hex').slice(0, 24)
      s.hash = null
      s.hashedTo = -1
      rec.result = await this.finish(rec, file, hash)
    } catch (err) {
      const e = err instanceof HttpError ? err : new HttpError(500, 'Errore interno del server')
      if (!(err instanceof HttpError)) logError('upload ' + rec.id + ' failed: ' + (err && err.stack ? err.stack : err))
      rec.error = { status: e.status, error: e.message, code: e.code || null }
      unlinkQuiet(this._part(rec.id))
    }
    rec.done = true
    rec.finishedAt = this.now()
    rec.updatedAt = rec.finishedAt
    s.processing = false
    if (!s.cancelled) this._save(rec)
  }

  /** A pipeline cut by a restart runs again. */
  rerun (id) {
    const s = this._s.get(id)
    if (!s || s.processing || s.rec.done) return null
    s.processing = true
    s.pipeline = this._runPipeline(s)
    return s.pipeline
  }

  replaceProfile (from, to) {
    for (const s of this._s.values()) {
      if (s.rec.profileId !== from) continue
      s.rec.profileId = to
      this._save(s.rec)
    }
  }

  dropProfile (profileId) {
    for (const s of [...this._s.values()]) if (s.rec.profileId === profileId) this._drop(s)
  }

  /** Expired sessions go: unfinished 24 h after their last chunk, finished after 1 h. */
  sweep (now = this.now()) {
    for (const s of [...this._s.values()]) {
      if (s.processing || s.current !== null) continue
      if (now >= this._expiresAt(s.rec)) this._drop(s)
    }
  }

  /** Wait for every running pipeline (tests, shutdown). */
  async settle () {
    await Promise.all([...this._s.values()].map((s) => s.pipeline).filter(Boolean).map((p) => p.catch(() => {})))
  }
}
