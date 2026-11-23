// The upload pipeline, the same for a single PUT, a finished session and every
// audio entry of an archive:
//   2. byte identical to a track (its id or its file): duplicate, the caller
//      becomes one of its uploaders;
//   3. an archive (by its magic): extracted in the background (archives.mjs);
//   4. the real audio check, cover, tags, codec, sample rate, bit depth;
//   5. fpcalc;
//   6. match against the library (fingerprint.mjs);
//   7. the same recording: first, is it the same version? A title that names
//      another version (instrumental, live, remix...) or a decode that differs
//      where the voice sits keeps both, and so does a pair that cannot be
//      compared. One version: replaced when better (after the tail check when
//      the caller is neither the owner nor an uploader of the kept track), else
//      a duplicate. Better is decided on the quality analysis of both files,
//      and when one is lossless and the other lossy, on the null test: a
//      lossless file decoded from that very lossy file is only a bigger copy of
//      it, so the lossy original is the one kept. "maybe": parked in pending/
//      until the uploader chooses (decided "both" for a caller that cannot
//      ask); an uploader who says "the same" is taken at their word;
//   8. a new track.
// A new track or a replaced file whose details are missing is looked up on the
// network (details.mjs); an archive's tracks when the archive is done, so its
// cover image counts first. The lyrics in a file's tags come from the same parse
// (lyrics.mjs): a new track takes them, another file of a kept track offers them.
// Steps 6 to 8 run one upload at a time, so two uploads of one song never both
// become new tracks. Edits, deletions and removed profiles do not wait for the
// pipeline: what it writes is decided on the library as it is at that moment.

import fs from 'node:fs'
import path from 'node:path'
import { HttpError, apiError } from './errors.mjs'
import { titleFromFileName } from './ids.mjs'
import { sniffAudio, readAudio, hasEnoughAudio, hasFrameChain, saveCover, buildTrack, HEAD_BYTES } from './media.mjs'
import { signatureOf, bestOffset, minPairsOf, MATCH, STEP } from './fingerprint.mjs'
import { tailArgs } from './ffmpeg.mjs'
import { applyQuality, measureQuality, skipsAnalysis, wantsQualityCheck, compareFiles, isBetter, scoreOf } from './quality.mjs'
import { unlinkQuietAsync, Mutex, newId16 } from './util.mjs'
import { differentVersions } from './versions.mjs'
import { lyricsFromTags } from './lrc.mjs'

const NOT_AUDIO = "Il file non e' un audio supportato (mp3, m4a, aac, flac, ogg, opus, wav)"
const TAIL_TIMEOUT = 120000
const TAIL_SECONDS = 120
// The lyrics a draft's tags carry (never stored on the track itself).
const TAG_LYRICS = new WeakMap()

/** The lyrics of a draft from its tags (lrc.mjs), or null. */
export function tagLyricsOf (draft) {
  return TAG_LYRICS.get(draft) || null
}

// Lyrics taken by nobody: a source without the lyrics part (tests of the pipeline alone).
const NO_LYRICS = { added () {}, offerTags () {} }

export function notAudio () {
  return new HttpError(415, NOT_AUDIO, 'not_audio')
}

// Is a track's title its file's name? (No title tag, nobody wrote one, the network gave none.)
function nameTitle (t) {
  const has = (list, f) => Array.isArray(list) && list.includes(f)
  return has(t.tagless, 'title') && !has(t.edited, 'title') && !(t.lookup && has(t.lookup.filled, 'title'))
}

/** The archive kind of a file from its first bytes: 'zip', '7z', 'rar' or null. */
export function archiveKindOf (head) {
  if (!head || head.length < 4) return null
  if (head[0] === 0x50 && head[1] === 0x4b && ((head[2] === 3 && head[3] === 4) || (head[2] === 5 && head[3] === 6))) return 'zip'
  if (head.length >= 6 && head.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))) return '7z'
  if (head.length >= 7 && head.subarray(0, 7).equals(Buffer.from('Rar!\x1a\x07\x00', 'latin1'))) return 'rar'
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from('Rar!\x1a\x07\x01\x00', 'latin1'))) return 'rar'
  return null
}

export async function readHead (file, n = HEAD_BYTES) {
  const fh = await fs.promises.open(file, 'r')
  try {
    const buf = Buffer.alloc(n)
    const { bytesRead } = await fh.read(buf, 0, n, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}

/**
 * Step 4: is it real audio we accept? The track draft (id = hash) with its
 * embedded cover saved. Throws 415 not_audio.
 */
export async function probeAudio (file, { hash, size, name, head = null, coversDir }) {
  if (head === null) head = await readHead(file)
  const sniffed = sniffAudio(head)
  if (sniffed === null) throw notAudio()
  let parsed
  try {
    parsed = await readAudio(file, sniffed, { duration: true })
  } catch {
    throw notAudio()
  }
  const format = parsed.format
  // The parser must agree with the magic bytes (an ID3 tag can sit in front of
  // MP3, ADTS or FLAC).
  const consistent = sniffed === 'id3'
    ? format === 'mp3' || format === 'aac' || format === 'flac'
    : format === sniffed || (sniffed === 'ogg' && format === 'opus')
  if (!format || !consistent) throw notAudio()
  // Four bytes of a valid MPEG frame header in front of anything parse as "mp3":
  // require real chained frames, and a song's worth of audio.
  if (!(await hasFrameChain(file, format))) throw notAudio()
  if (!hasEnoughAudio(format, parsed.metadata)) throw notAudio()
  let coverId = null
  try {
    coverId = saveCover(parsed.metadata, coversDir)
  } catch {
    coverId = null // a broken picture never blocks the upload
  }
  const track = buildTrack({ id: hash, format, metadata: parsed.metadata, size, fallbackTitle: titleFromFileName(name, hash), coverId, addedAt: Date.now() })
  track.fileHash = hash
  let lyrics = null
  try {
    lyrics = lyricsFromTags(parsed.metadata)
  } catch {
    lyrics = null // lyrics never block an upload
  }
  if (lyrics !== null) TAG_LYRICS.set(track, lyrics)
  return track
}

export class Pipeline {
  /**
   * @param {object} deps
   * @param {import('./library.mjs').Library} deps.library
   * @param {import('./jobs.mjs').MediaJobs} deps.jobs
   * @param {import('./fingerprint.mjs').Fingerprints} deps.fingerprints
   * @param {object|null} deps.ffmpeg  a FfmpegRunner (fake check, tail check) or null
   * @param {() => boolean} deps.ffmpegReady
   * @param {import('./pending.mjs').PendingStore} deps.pending
   * @param {() => import('./archives.mjs').Archives} deps.archives
   * @param {import('./disk.mjs').Disk|null} [deps.disk]
   * @param {(actor: string) => boolean} [deps.isRemoved]  a profile removed from the source
   * @param {(trackId: string) => void} [deps.lookup]  queue a details lookup of an upload
   * @param {object} [deps.lyrics]  the lyrics of the tracks (lyrics.mjs)
   */
  constructor ({ library, jobs, fingerprints, ffmpeg, ffmpegReady = () => ffmpeg !== null, pending, archives, disk = null, isRemoved = () => false, lookup = () => {}, lyrics = NO_LYRICS }) {
    this.library = library
    this.jobs = jobs
    this.fingerprints = fingerprints
    this.ffmpeg = ffmpeg
    this.ffmpegReady = ffmpegReady
    this.pending = pending
    this.archives = archives
    this.disk = disk
    this.isRemoved = isRemoved
    this.lookup = lookup
    this.lyrics = lyrics
    this.lock = new Mutex()
  }

  // An archive's tracks are looked up when the archive is done (its cover first).
  _lookupLater (trackId, archiveId) {
    if (archiveId !== null && this.archives().importing(archiveId)) return
    this.lookup(trackId)
  }

  // A removed profile gets nothing more on this source, whatever was running for it.
  _live (caller, draft = null) {
    if (!this.isRemoved(caller.actor)) return
    if (draft !== null) this.library.dropCoverIfUnused(draft.coverId)
    throw apiError('forbidden')
  }

  // The kept track as it is now, or null when it is gone (or holds another file).
  _still (id, fileHash) {
    const t = this.library.getTrack(id)
    return t !== null && t.fileHash === fileHash ? t : null
  }

  // The caller becomes one of the track's uploaders, then the upload goes.
  async _claim (track, caller, file, draft = null, archiveId = null) {
    this._live(caller, draft)
    this.library.addUploader(track.id, caller.actor)
    if (draft !== null) {
      // A track whose album the upload changed is looked up again; in an archive,
      // when the archive is done (its own cover first).
      const filled = this.library.fillEmpty(track.id, draft, { lookup: archiveId === null })
      if (filled.stale && archiveId !== null) this._lookupLater(track.id, archiveId)
      this.library.dropCoverIfUnused(draft.coverId)
      this.lyrics.offerTags(track.id, tagLyricsOf(draft))
    }
    await unlinkQuietAsync(file)
    return { outcome: 'duplicate', trackId: track.id }
  }

  /**
   * Run a received file through the pipeline. The file is consumed (moved or
   * deleted) whatever happens.
   * @param {object} job
   * @param {string} job.file
   * @param {string} job.hash   24 hex of the content SHA-256
   * @param {number} job.size
   * @param {string} job.name   the client's file name (title fallback only)
   * @param {object} job.caller { actor, role, ask }
   * @param {string|null} [job.archiveId]  an entry of this archive
   * @returns {Promise<object>} { outcome, trackId?, pending?, archiveId? }
   */
  async ingest ({ file, hash, size, name, caller, archiveId = null }) {
    try {
      const same = this.library.findByHash(hash)
      if (same !== null) {
        // The same bytes as a track whose card is away: they become its file.
        if (same.fileHash === hash) this.library.restoreFile(same, file)
        return await this._claim(same, caller, file)
      }
      const head = await readHead(file)
      const kind = archiveKindOf(head)
      if (kind !== null) {
        if (archiveId !== null) {
          await unlinkQuietAsync(file)
          return { outcome: 'ignored' }
        }
        this._live(caller)
        const id = await this.archives().start({ file, kind, name, caller })
        return { outcome: 'archive', archiveId: id }
      }
      const draft = await probeAudio(file, { hash, size, name, head, coversDir: this.library.coversDir })
      const fp = await this._fingerprint(file)
      return await this.lock.run(() => this._decide({ file, hash, draft, fp, caller, archiveId, name }))
    } catch (err) {
      await unlinkQuietAsync(file)
      throw err
    }
  }

  async _fingerprint (file) {
    const fps = this.fingerprints
    if (!fps.available) return { state: 'none', fp: null }
    const fp = await fps.limiter.run(() => fps.compute(file))
    return fp === null ? { state: 'failed', fp: null } : { state: 'ok', fp }
  }

  async _decide ({ file, hash, draft, fp, caller, archiveId, name }) {
    // The same bytes may have landed while this one was being read.
    const again = this.library.findByHash(hash)
    if (again !== null) {
      this._live(caller, draft)
      if (again.fileHash === hash) this.library.restoreFile(again, file)
      this.library.addUploader(again.id, caller.actor)
      this.library.dropCoverIfUnused(draft.coverId)
      await unlinkQuietAsync(file)
      return { outcome: 'duplicate', trackId: again.id }
    }
    const match = fp.fp === null ? null : this.fingerprints.match(fp.fp, (trackId) => {
      const t = this.library.getTrack(trackId)
      return t === null || t.notSame.includes(hash)
    })
    const kept = match === null ? null : this.library.getTrack(match.trackId)
    if (kept === null) return this._addNew({ file, draft, fp, caller, archiveId })
    if (match.kind === 'same') return this._same({ file, draft, fp, caller, kept, archiveId, shift: this._shiftTo(fp, kept) })
    if (!caller.ask) return this._addNew({ file, draft, fp, caller, notSameWith: kept.id, archiveId })
    return this._park({ file, hash, draft, fp, caller, kept, ber: match.ber, archiveId, name })
  }

  // 8. A new track.
  async _addNew ({ file, draft, fp, caller, notSameWith = null, archiveId = null }) {
    const lib = this.library
    this._live(caller, draft)
    const track = { ...draft, uploaders: [caller.actor], notSame: [], fpState: fp.state, fp: null, edited: [] }
    if (fp.fp !== null) track.fp = signatureOf(fp.fp.items, track.duration !== null ? track.duration : fp.fp.duration)
    track.score = scoreOf(track)
    // Committed on internal memory (where it was staged): its jobs read it there,
    // and a card in use takes it afterwards. Its new name must be durable before
    // the log can mention it.
    const dest = lib.places.commitSync(file, 'library/' + track.id.slice(0, 2) + '/' + path.basename(lib.trackPath(track)))
    try { fs.chmodSync(dest, 0o644) } catch {}
    const added = lib.addTrack(track)
    if (fp.fp !== null) {
      this.fingerprints.save(added.fileHash, fp.fp)
      this.fingerprints.indexAdd(added.id, added.fileHash, fp.fp.duration)
    }
    if (notSameWith !== null) lib.markNotSame(added.id, notSameWith)
    this.lyrics.added(added.id, tagLyricsOf(draft))
    this.jobs.onUpload(added)
    this._lookupLater(added.id, archiveId)
    return { outcome: 'added', trackId: added.id }
  }

  // The quality fields of a file (the measurement, or none for a lossless file
  // under 44.1 kHz).
  async _analyse (t, file) {
    return applyQuality(t, skipsAnalysis(t) ? null : await measureQuality(this.ffmpeg, file, t.duration))
  }

  // Where the kept track sounds like the upload, from the best offset of the two
  // fingerprints: the kept file at t + shift is the upload at t (seconds).
  _shiftTo (fp, kept) {
    if (fp.fp === null || !this.fingerprints) return 0
    const stored = this.fingerprints.read(kept.fileHash)
    if (stored === null) return 0
    const best = bestOffset(fp.fp.items, stored.items, MATCH.offsets)
    return best === null ? 0 : best.k * STEP
  }

  // 7. The same recording. One version or two? Then quality decides. The checks
  // take a while: the kept track is read again after each of them (edited,
  // deleted meanwhile). `confirmed`: the uploader said they are the same song.
  async _same ({ file, draft, fp, caller, kept, archiveId = null, shift = 0, confirmed = false }) {
    const lib = this.library
    const { id, fileHash } = kept
    const both = (notSameWith) => this._addNew({ file, draft, fp, caller, notSameWith, archiveId })
    if (!confirmed && differentVersions(draft.title, kept.title, { aName: nameTitle(draft), bName: nameTitle(kept) })) return both(kept.id)
    // Its file on a memory card that is away: nothing to compare with now.
    if (!lib.originalReady(kept)) return both(null)
    let decoded = null
    if (this.ffmpegReady()) {
      if (wantsQualityCheck(draft)) await this._analyse(draft, file)
      if (wantsQualityCheck(kept)) {
        const t = await lib.withLocalFile(kept, (keptFile) => this._analyse({ ...kept }, keptFile))
        const now = this._still(id, fileHash)
        if (now !== null) lib.setTrack({ ...now, cutoffHz: t.cutoffHz, equivKbps: t.equivKbps, fakeLossless: t.fakeLossless, qualityV: t.qualityV })
      }
      kept = this._still(id, fileHash)
      if (kept === null) return both(null)
      const c = await lib.withLocalFile(kept, (keptFile) => compareFiles(this.ffmpeg,
        { file, duration: draft.duration, lossless: draft.lossless },
        { file: keptFile, duration: kept.duration, lossless: kept.lossless }, shift))
      if (!confirmed && c.sameVersion !== true) return both(c.sameVersion === false ? kept.id : null)
      decoded = c.decoded
    } else if (!confirmed) {
      // Nothing to compare them with: both stay.
      return both(null)
    }
    kept = this._still(id, fileHash)
    if (kept === null) return both(null)
    if (decoded === true) {
      // The lossless file holds the samples of the lossy one: the lossy file is
      // the original, the other only a bigger copy of it.
      if (draft.lossless) return this._claim(kept, caller, file, draft, archiveId)
      return this._replaceChecked({ file, draft, fp, caller, kept, archiveId })
    }
    draft.score = scoreOf(draft)
    if (isBetter(draft.score, kept.score)) return this._replaceChecked({ file, draft, fp, caller, kept, archiveId })
    return this._claim(kept, caller, file, draft, archiveId)
  }

  // A replacement, after the tail check when the caller needs it.
  async _replaceChecked ({ file, draft, fp, caller, kept, archiveId = null }) {
    if (this._needsTail(caller, kept)) {
      const { id, fileHash } = kept
      const passed = await this.library.withLocalFile(kept, (keptFile) => this._tailCheck(file, keptFile, [draft, kept])).catch(() => false)
      kept = this._still(id, fileHash)
      if (kept === null) return this._addNew({ file, draft, fp, caller, archiveId })
      if (!passed) return this._addNew({ file, draft, fp, caller, notSameWith: kept.id, archiveId })
    }
    return this._replace({ file, draft, fp, caller, kept, archiveId })
  }

  // A replacement destroys the kept file: unless the caller is the owner or the
  // only one it belongs to, the last two minutes must match too. (Uploading the
  // same bytes first makes anyone an uploader: that alone is not enough.)
  _needsTail (caller, kept) {
    if (caller.role === 'owner') return false
    return kept.uploaders.length === 0 || kept.uploaders.some((u) => u !== caller.actor)
  }

  async _replace ({ file, draft, fp, caller, kept, archiveId = null }) {
    const lib = this.library
    this._live(caller, draft)
    // A job still reading the old file stops first.
    const { id, fileHash } = kept
    const stopped = await this.jobs.stopFor(id)
    kept = this._still(id, fileHash)
    if (kept === null) return this._addNew({ file, draft, fp, caller, archiveId })
    const fields = {
      format: draft.format,
      size: draft.size,
      bitrate: draft.bitrate,
      duration: draft.duration,
      lossless: draft.lossless,
      codec: draft.codec,
      sampleRate: draft.sampleRate,
      bitDepth: draft.bitDepth,
      fileHash: draft.fileHash,
      // Another file: its own analysis (or none yet: the background makes it).
      fakeLossless: draft.fakeLossless === undefined ? null : draft.fakeLossless,
      equivKbps: draft.equivKbps === undefined ? null : draft.equivKbps,
      cutoffHz: draft.cutoffHz === undefined ? null : draft.cutoffHz,
      qualityV: Number.isInteger(draft.qualityV) ? draft.qualityV : 0,
      fp: fp.fp !== null ? signatureOf(fp.fp.items, draft.duration !== null ? draft.duration : fp.fp.duration) : null,
      fpState: fp.state
    }
    let replaced
    try {
      this._live(caller, draft)
      replaced = lib.replaceFile(kept.id, file, fields, draft)
    } catch (err) {
      // The old file stays: the job stopped for it goes on.
      this.jobs.again(stopped)
      throw err
    }
    const { track, old } = replaced
    if (fp.fp !== null) this.fingerprints.save(draft.fileHash, fp.fp)
    lib.addUploader(track.id, caller.actor)
    if (old.fileHash !== track.fileHash) this.fingerprints.remove(old.fileHash)
    if (fp.fp !== null) this.fingerprints.indexAdd(track.id, track.fileHash, fp.fp.duration)
    else this.fingerprints.indexRemove(track.id)
    lib.dropCoverIfUnused(draft.coverId)
    this.lyrics.offerTags(track.id, tagLyricsOf(draft))
    this.jobs.onFileReplaced(lib.getTrack(track.id))
    this._lookupLater(track.id, archiveId)
    return { outcome: 'replaced', trackId: track.id }
  }

  async _park ({ file, hash, draft, fp, caller, kept, ber, archiveId, name }) {
    this._live(caller, draft)
    const rec = await this.pending.add({
      file,
      ext: path.extname(this.library.trackPath(draft)).slice(1),
      profileId: caller.actor,
      name,
      fileHash: hash,
      matchTrackId: kept.id,
      ber,
      candidate: {
        title: draft.title,
        artist: draft.artist,
        album: draft.album,
        duration: draft.duration,
        format: draft.format,
        codec: draft.codec,
        bitrate: draft.bitrate,
        lossless: draft.lossless,
        score: scoreOf(draft)
      },
      archiveId,
      fp: fp.fp,
      role: caller.role
    })
    this.library.dropCoverIfUnused(draft.coverId)
    return { outcome: 'maybe', pending: rec }
  }

  /**
   * The answer to a "maybe" (or its expiry): 'best' decided as the same song,
   * 'both' as a new track. Returns the internal result.
   */
  decidePending (rec, keep, caller) {
    return this.lock.run(async () => {
      const file = this.pending.filePath(rec)
      try {
        const st = await fs.promises.stat(file)
        const draft = await probeAudio(file, { hash: rec.fileHash, size: st.size, name: rec.name, coversDir: this.library.coversDir })
        const fp = rec.fp ? { state: 'ok', fp: rec.fp } : { state: 'failed', fp: null }
        const again = this.library.findByHash(rec.fileHash)
        if (again !== null) {
          this._live(caller, draft)
          this.library.addUploader(again.id, caller.actor)
          this.library.dropCoverIfUnused(draft.coverId)
          await unlinkQuietAsync(file)
          return { outcome: 'duplicate', trackId: again.id }
        }
        const kept = this.library.getTrack(rec.matchTrackId)
        if (kept === null) return await this._addNew({ file, draft, fp, caller })
        if (keep === 'best') return await this._same({ file, draft, fp, caller, kept, shift: this._shiftTo(fp, kept), confirmed: true })
        return await this._addNew({ file, draft, fp, caller, notSameWith: kept.id })
      } catch (err) {
        await unlinkQuietAsync(file)
        throw err
      } finally {
        this.pending.forget(rec.id)
      }
    })
  }

  /**
   * The last 120 s of both files, fingerprinted: do they match too (BER <= 0.10
   * over offsets -24..24)? Any failure: no.
   */
  async _tailCheck (a, b, tracks) {
    if (!this.ffmpegReady() || !this.fingerprints.available) return false
    const tmpDir = this.library.tmpDir
    const files = [path.join(tmpDir, 't-' + newId16() + '.wav'), path.join(tmpDir, 't-' + newId16() + '.wav')]
    try {
      // Two minutes of mono 16-bit WAV of each file: they must fit above the floor.
      if (this.disk !== null) await this.disk.check(tracks.reduce((n, t) => n + TAIL_SECONDS * 2 * Math.max(48000, t.sampleRate || 0), 0))
      const fps = []
      for (const [i, input] of [a, b].entries()) {
        await this.ffmpeg.run(tailArgs(path.resolve(input), files[i]), { timeoutMs: TAIL_TIMEOUT, quiet: true })
        const fp = await this.fingerprints.compute(files[i])
        if (fp === null) return false
        fps.push(fp)
      }
      const best = bestOffset(fps[0].items, fps[1].items, MATCH.tailOffsets, minPairsOf(fps[0].items, fps[1].items))
      return best !== null && best.ber <= MATCH.sameBer
    } catch {
      return false
    } finally {
      for (const f of files) await unlinkQuietAsync(f)
    }
  }
}

/** The upload result of 14.7 for a caller (`viewer`: the ids that count as them). */
export function renderResult (result, library, viewer, pendingView = null) {
  const out = { outcome: result.outcome, duplicate: result.outcome === 'duplicate' || result.outcome === 'replaced' }
  if (result.trackId) {
    const t = library.getTrack(result.trackId)
    if (t !== null) out.track = library.publicTrack(t, viewer)
  }
  if (result.outcome === 'maybe' && result.pending) out.pending = (pendingView || defaultPendingView)(result.pending, library, viewer)
  if (result.outcome === 'archive') out.archive = { id: result.archiveId }
  return out
}

export function defaultPendingView (rec, library, viewer) {
  const match = library.getTrack(rec.matchTrackId)
  return {
    id: rec.id,
    match: match === null ? null : library.publicTrack(match, viewer),
    candidate: rec.candidate,
    expiresAt: rec.expiresAt
  }
}
