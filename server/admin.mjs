// Admin port 8092: 127.0.0.1 only and never forwarded over P2P (the transport only
// ever connects to the HTTP port). Since v2 it only reports health; pairing and
// clients are handled by /api/admin/* on 8091 and by the CLI (server/index.mjs).
//   curl -s http://127.0.0.1:8092/admin/health

import fs from 'node:fs'
import path from 'node:path'
import { HttpError } from './errors.mjs'
import { readJsonFile, renameSyncRetry, fsyncDirSync, logError } from './util.mjs'
import { sendJson, sendError, hostAllowed, originAllowed, segments } from './respond.mjs'

const HOUR = 60 * 60 * 1000

/**
 * The /api/library requests of apps that read no deltas (no delta=1 or 2; GET and
 * HEAD, 304s included): how many since the process started, and when the last one
 * came. Such apps cost the source more (every full answer built again, the whole
 * likes list at every heart), so the bigger caps wait until none has asked for a
 * week. The time is kept in legacy-library.json ({"lastAt":<ms>}, by a temporary
 * file and a rename, at most once an hour while such requests come and at a
 * graceful stop when it moved), so a restart never forgets that an old app asked.
 */
export class LegacyLibrary {
  /**
   * @param {string|null} dataDir  null: kept in memory only
   * @param {{ now?: () => number }} [opts]
   */
  constructor (dataDir, { now = Date.now } = {}) {
    this.file = dataDir ? path.join(dataDir, 'legacy-library.json') : null
    this.now = now
    this.count = 0
    const kept = this.file !== null ? readJsonFile(this.file) : null
    this.lastAt = kept !== null && typeof kept === 'object' && Number.isSafeInteger(kept.lastAt) && kept.lastAt > 0 ? kept.lastAt : null
    this._onDisk = this.lastAt // the time the file holds (or is being given)
    this._savedAt = -Infinity // when this run last wrote it
    this._saving = Promise.resolve()
  }

  /** One such request, now. */
  note () {
    this.count++
    this.lastAt = this.now()
    if (this.lastAt - this._savedAt >= HOUR) this._save()
  }

  /** What GET /admin/health shows. */
  view () {
    return { count: this.count, lastAt: this.lastAt }
  }

  /** The time written now when it moved since the file was last written (a graceful stop). */
  async close () {
    if (this.lastAt !== this._onDisk) this._save()
    await this._saving
  }

  /** Resolves when no write is under way. */
  settled () {
    return this._saving
  }

  // Written in the background, one write at a time, in the order asked.
  _save () {
    if (this.file === null) return
    const at = this.lastAt
    this._savedAt = at
    this._onDisk = at
    const text = JSON.stringify({ lastAt: at }) + '\n'
    this._saving = this._saving.then(() => writeSmallFile(this.file, text)).catch((err) => {
      logError('legacy-library.json not written: ' + err.message)
    })
  }
}

// A small file written whole: a temporary file, fsync, a rename over it, the
// directory fsynced. A crash leaves the old content or the new one.
async function writeSmallFile (file, text) {
  const tmp = file + '.tmp'
  const fh = await fs.promises.open(tmp, 'w', 0o600)
  try {
    await fh.writeFile(text)
    await fh.sync()
  } finally {
    await fh.close()
  }
  renameSyncRetry(tmp, file)
  fsyncDirSync(path.dirname(file))
}

/**
 * @param {object} ctx
 * @param {import('./clients.mjs').ClientsStore} ctx.clients
 * @param {() => object|null} ctx.transport
 * @param {string} ctx.serverPublicKey  hex
 * @param {import('./jobs.mjs').MediaJobs} ctx.jobs
 * @param {import('./source.mjs').SourceStore} ctx.source
 * @param {import('./fingerprint.mjs').Fingerprints} ctx.fingerprints
 * @param {import('./sevenzip.mjs').SevenZip} ctx.sevenZip
 * @param {import('./details.mjs').Details} ctx.details
 * @param {import('./lyrics.mjs').Lyrics} [ctx.lyrics]
 * @param {import('./comments.mjs').CommentsStore} [ctx.comments]
 * @param {LegacyLibrary} [ctx.legacyLibrary]  the library requests of apps that read no deltas
 * @param {Set<string>} ctx.extraHosts
 */
export function createAdminHandler (ctx) {
  return async function handle (req, res) {
    try {
      if (!hostAllowed(req, ctx.extraHosts)) throw new HttpError(403, 'Host non consentito')
      if (req.method !== 'GET' && req.method !== 'HEAD' && !originAllowed(req, ctx.extraHosts)) {
        throw new HttpError(403, 'Origine non consentita')
      }
      const pathname = new URL(req.url, 'http://127.0.0.1').pathname
      if (pathname !== '/admin' && !pathname.startsWith('/admin/')) throw new HttpError(404, 'Risorsa non trovata')
      const seg = segments(pathname, '/admin/')

      if (seg.length === 1 && seg[0] === 'health' && (req.method === 'GET' || req.method === 'HEAD')) {
        const transport = ctx.transport()
        const info = transport ? transport.info() : null
        const jobs = ctx.jobs
        let places
        if (ctx.places) {
          const counts = ctx.library.cardCounts()
          places = await ctx.places.health({ tracks: counts.tracks, awayTracks: counts.away })
        }
        return sendJson(req, res, 200, {
          ok: true,
          name: ctx.source.name,
          serverPublicKey: ctx.serverPublicKey,
          clients: ctx.clients.list().length,
          p2p: transport !== null,
          listening: transport ? transport.listening : false,
          dht: info ? info.dht : null,
          connections: info ? info.connections : 0,
          pairing: info ? info.pairing : null,
          transport: info ? info.stats : null,
          media: {
            ffmpeg: jobs.ffmpegAvailable,
            opus: jobs.opusAvailable,
            busy: jobs.busy,
            transcodeBytes: jobs.totalBytes,
            capBytes: jobs.capBytes,
            ...jobs.stats
          },
          fpcalc: ctx.fingerprints.available,
          fingerprints: { indexed: ctx.fingerprints.size, queued: jobs.queuedOf('fingerprint') },
          archives: { zip: true, sevenZip: ctx.sevenZip.available, rar: ctx.sevenZip.supports('rar') },
          sevenZip: { command: ctx.sevenZip.command, version: ctx.sevenZip.version },
          details: ctx.details.health(),
          lyrics: ctx.lyrics ? ctx.lyrics.health() : null,
          comments: ctx.comments ? ctx.comments.size : null,
          legacyLibrary: ctx.legacyLibrary ? ctx.legacyLibrary.view() : null,
          places
        })
      }

      throw new HttpError(404, 'Risorsa non trovata')
    } catch (err) {
      sendError(req, res, err)
    }
  }
}
