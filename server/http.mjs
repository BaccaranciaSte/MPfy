// HTTP API on port 8091 (127.0.0.1 only; this is what the P2P link forwards to).
//
// Requests come either from 127.0.0.1 directly (local: the CLI, a shell on the
// source) or through the P2P channel of an admitted client, whose sockets come
// from 127.0.0.2. Who is asking, with which profile and role, is decided once,
// when the request arrives (people.mjs), and kept on the request. The server
// enforces the permissions; the app only hides what a member cannot do.

import crypto from 'node:crypto'
import fs from 'node:fs'
import zlib from 'node:zlib'
import { promisify } from 'node:util'
import { Writable, pipeline as pipeCallback } from 'node:stream'
import { pipeline as pipeStreams } from 'node:stream/promises'
import { HttpError, apiError } from './errors.mjs'
import {
  isTrackId, isCoverId, isPublicKey, isProfileId, albumIdOf, cleanUploadName, COVER_MIME, COVER_SIZES, QUALITY_NAMES
} from './ids.mjs'
import { parseRange, UNSATISFIABLE } from './range.mjs'
import { acceptsGzip, etagMatches } from './static.mjs'
import { saveCoverBytes } from './media.mjs'
import { STEP, packItems } from './fingerprint.mjs'
import { receiveUpload } from './upload.mjs'
import { renderResult, defaultPendingView } from './pipeline.mjs'
import { validRecoveryBody } from './recovery.mjs'
import { validPhoto } from './profiles.mjs'
import { SOCIAL_VERSION, AHEAD_MS } from './social.mjs'
import { directIdOf, accessValid, BODY_BASE, BODY_PER_RECIPIENT, PAGE, MAX_PAGE, MAX_WAIT_MS } from './chat.mjs'
import { RECENTS_PAGE, MAX_RECENTS_PAGE, MAX_RECENTS } from './users.mjs'
import { cleanName } from './util.mjs'
import { ACOUSTID_KEY_RE } from './details.mjs'
import { MAX_ASKED } from './comments.mjs'
import { LyricsError, MAX_LYRICS_BYTES } from './lrc.mjs'
import { LegacyLibrary } from './admin.mjs'
import { storageView, storageAction } from './storage.mjs'
import { sendJson, sendError, readJson, readJsonObject, readBody, hostAllowed, originAllowed, segments } from './respond.mjs'

const gzip = promisify(zlib.gzip)
const IMMUTABLE = 'private, max-age=31536000, immutable'
// ?size= asked but only the original exists yet: cache it briefly, the resized
// version may follow.
const SIZE_FALLBACK_CACHE = 'private, max-age=600'
const MAX_CUSTOM_COVER = 8 * 1024 * 1024
const BODY_CACHE = 16
const BODY_CACHE_BYTES = 32 * 1024 * 1024
const JSON_TYPE = 'application/json; charset=utf-8'
// An answer body under this size is built whole (and cached when it can be);
// a larger one is streamed as it is written.
const CACHED_BODY = 1024 * 1024
// The pieces a large answer is written in: tracks, likes, cover entries per
// piece, and at most this much text for anything else (playlists).
const TRACK_SLICE = 250
const LIKES_SLICE = 5000
const COVERS_SLICE = 1000
const SLICE_TEXT = 256 * 1024
// A piece of an answer kept in memory this small is taken at once, without a turn of its own.
const SMALL_PIECE = 16 * 1024
const EPOCH_RE = /^[0-9a-f]{16}$/
// PUT /api/profile/photo: a photo of at most 48 KB in base64, and its time.
const MAX_PHOTO_JSON = 128 * 1024
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
// The social bodies: a card (about 500 bytes), the settings (10,000 blocked ids
// and a 64 KB mutes box at most), an activity report (three texts of 200 code
// points, escaped).
const MAX_CARD_JSON = 4 * 1024
const MAX_SOCIAL_JSON = 512 * 1024
const MAX_ACTIVITY_JSON = 16 * 1024
// A read mark, an access entry.
const MAX_SMALL_JSON = 1024
// A comment: 300 code points, escaped, and its id, track and time.
const MAX_COMMENT_JSON = 8 * 1024
const HEX32_RE = /^[0-9a-f]{32}$/
const SIG_RE = /^[0-9a-f]{128}$/

/**
 * The body of an answer that may be large (the library, a likes list), written to
 * it piece by piece. While it stays under CACHED_BODY it is only kept, so the
 * caller can cache it and send it with its length. Once it passes that size it is
 * streamed instead: the response starts (chunked, through a gzip stream when
 * `zip`), and from then on a write is taken only when the gzip stream and the
 * response have room again, so write() answers false (wait for 'drain') while a
 * slow reader has not taken what it was given, and the source never holds the
 * body. `abort` is called when the response or the gzip stream goes away first.
 */
class AnswerBody extends Writable {
  constructor (res, zip, abort) {
    super()
    this._res = res
    this._zip = zip
    this._abort = abort
    this._parts = []
    this._size = 0
    this._out = null // the gzip stream or the response, once streamed
  }

  get streamed () {
    return this._out !== null
  }

  /** The whole body, when it was not streamed. */
  bytes () {
    return Buffer.concat(this._parts)
  }

  // Each large piece is taken in a turn of its own (setImmediate): when the socket
  // takes everything at once, the pieces still never run back to back in one turn.
  _write (chunk, encoding, cb) {
    if (this._out === null) {
      this._parts.push(chunk)
      this._size += chunk.length
      if (this._size < CACHED_BODY) {
        if (chunk.length < SMALL_PIECE) cb()
        else setImmediate(cb)
        return
      }
      this._start()
      chunk = Buffer.concat(this._parts)
      this._parts = []
    }
    this._out.write(chunk)
    roomIn([this._out, this._res]).then(() => setImmediate(cb), () => this._fail())
  }

  _start () {
    const res = this._res
    res.statusCode = 200
    if (!this._zip) {
      this._out = res
      return
    }
    this._out = zlib.createGzip()
    pipeCallback(this._out, res, (err) => {
      if (err) this._fail()
    })
  }

  _fail () {
    this._abort()
    this.destroy()
  }

  _final (cb) {
    if (this._out === null) {
      cb()
      return
    }
    const res = this._res
    const done = () => {
      res.off('finish', done)
      res.off('close', done)
      cb()
    }
    res.on('finish', done)
    res.on('close', done)
    this._out.end()
  }

  _destroy (err, cb) {
    if (this._out !== null && !this._res.writableFinished) {
      if (this._out !== this._res) this._out.destroy()
      this._res.destroy()
    }
    cb(err)
  }
}

// Until none of these streams asks to drain; rejects when one is gone first.
async function roomIn (streams) {
  for (;;) {
    if (streams.some((s) => s.destroyed)) throw abortError()
    const full = streams.find((s) => s.writableNeedDrain)
    if (full === undefined) return
    await new Promise((resolve, reject) => {
      const done = (err) => {
        full.off('drain', onDrain)
        full.off('close', onClose)
        if (err) reject(err)
        else resolve()
      }
      const onDrain = () => done(null)
      const onClose = () => done(abortError())
      full.on('drain', onDrain)
      full.on('close', onClose)
    })
  }
}

// Text written to an answer body, waiting while the body asks to (write() false).
async function put (out, text, signal) {
  if (signal.aborted) throw abortError()
  if (out.write(text)) return
  await new Promise((resolve, reject) => {
    const done = (err) => {
      out.off('drain', onDrain)
      out.off('close', onClose)
      signal.removeEventListener('abort', onClose)
      if (err) reject(err)
      else resolve()
    }
    const onDrain = () => done(null)
    const onClose = () => done(abortError())
    out.on('drain', onDrain)
    out.on('close', onClose)
    signal.addEventListener('abort', onClose)
  })
}

// The JSON of each item (null: left out) joined by commas, written in pieces of
// `per` items or SLICE_TEXT characters, whichever comes first.
async function putEach (out, items, toJson, signal, per = Infinity) {
  let text = ''
  let n = 0
  let first = true
  for (const item of items) {
    if (signal.aborted) throw abortError()
    const json = toJson(item)
    if (json === null) continue
    text += first ? json : ',' + json
    first = false
    if (++n >= per || text.length >= SLICE_TEXT) {
      await put(out, text, signal)
      text = ''
      n = 0
    }
  }
  if (text !== '') await put(out, text, signal)
}

function abortError () {
  const err = new Error('aborted')
  err.name = 'AbortError'
  return err
}

/**
 * @param {object} ctx  everything a request may need (see app.mjs)
 */
export function createApiHandler (ctx) {
  const { library, users, people, social, chat } = ctx
  const bodyCache = new Map() // etag|what was asked -> { json, gzip }
  // The library requests of apps that read no deltas (shown by the admin port).
  const legacy = ctx.legacyLibrary || new LegacyLibrary(ctx.dataDir)
  // What the answers say of the source besides the tracks: its owner apart, since
  // a new owner changes which tracks the owner acting without a profile calls its own.
  const sourceState = () => {
    const s = ctx.source.data
    return { owner: s.ownerProfileId, rest: JSON.stringify([s.name, s.named, s.details]) }
  }
  let sourceSeen = ctx.source ? sourceState() : null

  return async function handle (req, res) {
    try {
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('Referrer-Policy', 'no-referrer')
      if (!hostAllowed(req, ctx.extraHosts)) throw new HttpError(403, 'Host non consentito')
      const method = req.method
      if (method !== 'GET' && method !== 'HEAD' && !originAllowed(req, ctx.extraHosts)) {
        throw new HttpError(403, 'Origine non consentita')
      }
      // Who is asking: read once, now, before anything can wait (a channel closed
      // later takes its port mapping with it).
      const caller = people.resolve(req, ctx.whoIs)
      req.mpfy = caller

      let url
      try {
        url = new URL(req.url, 'http://127.0.0.1')
      } catch {
        throw new HttpError(400, 'Percorso non valido')
      }
      const pathname = url.pathname

      if (pathname === '/api' || pathname.startsWith('/api/')) {
        await api(req, res, segments(pathname, '/api/'), url.searchParams, caller)
        return
      }

      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Metodo non consentito')
      let decoded
      try {
        decoded = decodeURIComponent(pathname)
      } catch {
        throw new HttpError(400, 'Percorso non valido')
      }
      if (decoded.includes('\0')) throw new HttpError(400, 'Percorso non valido')
      const served = ctx.staticFiles !== null && (await ctx.staticFiles.serve(req, res, decoded))
      if (!served) throw new HttpError(404, 'Interfaccia non installata')
    } catch (err) {
      sendError(req, res, err)
    }
  }

  // ------------------------------------------------------------------ roles

  // A guest (a device without a profile in the recovery flow) may only do these.
  function guestAllowed (method, seg) {
    const [a, b, c, d] = seg
    const n = seg.length
    const read = method === 'GET' || method === 'HEAD'
    if (read && n === 1 && (a === 'health' || a === 'profile')) return true
    if (a === 'recovery' && read && (n === 2 || n === 3) && (n === 2 ? b === 'profiles' : true)) return true
    if (a === 'recovery' && method === 'POST' && n === 4 && d === 'release') return true
    if (a === 'admin' && method === 'DELETE' && n === 3 && b === 'clients' && c === 'self') return true
    return false
  }

  function ownerOnly (caller) {
    if (caller.role !== 'owner') throw apiError('forbidden')
  }

  function viewerOf (caller) {
    if (caller.role === 'guest') return new Set()
    if (caller.profileId === null) return people.viewerForActor(caller.actor)
    return new Set([caller.profileId])
  }

  function ownTrack (caller, track) {
    const viewer = viewerOf(caller)
    return track.uploaders.some((u) => viewer.has(u))
  }

  // Own album: at least one track here and every one of them the caller's.
  function ownAlbum (caller, albumId) {
    let any = false
    for (const t of library.tracks.values()) {
      if (albumIdOf(t) !== albumId) continue
      any = true
      if (!ownTrack(caller, t)) return false
    }
    return any
  }

  // A person's data, held while the request uses it (see users.open): let go when the
  // handler ends, or when the response closes first.
  async function hold (res, key) {
    const held = await users.open(key)
    res.once('close', held.release)
    return held
  }

  function playlistRoute (method, n, c) {
    return (n === 1 && method === 'POST') || (n === 2 && (method === 'PATCH' || method === 'DELETE')) ||
      (n === 3 && c === 'tracks' && (method === 'POST' || method === 'DELETE'))
  }

  // ---------------------------------------------------------------- routes

  async function api (req, res, seg, query, caller) {
    const method = req.method
    const [a, b, c] = seg
    const n = seg.length

    if (caller.role === 'guest' && !guestAllowed(method, seg)) throw apiError('no_profile')

    if (n === 1 && a === 'health' && (method === 'GET' || method === 'HEAD')) return health(req, res)
    if (n === 1 && a === 'library' && (method === 'GET' || method === 'HEAD')) return getLibrary(req, res, caller, query)
    if (n === 2 && a === 'stream' && (method === 'GET' || method === 'HEAD')) return stream(req, res, b, query)
    if (n === 2 && a === 'cover' && (method === 'GET' || method === 'HEAD')) return cover(req, res, b, query)
    if (n === 2 && a === 'fingerprint' && (method === 'GET' || method === 'HEAD')) return fingerprint(req, res, b, query)

    if (n === 2 && a === 'upload' && method === 'PUT') return uploadSingle(req, res, b, caller)
    if (a === 'uploads') return uploads(req, res, seg, query, caller)
    if (n === 2 && a === 'pending' && method === 'POST') return answerPending(req, res, b, caller)
    if (n === 2 && a === 'archives' && (method === 'GET' || method === 'HEAD')) {
      return sendJson(req, res, 200, ctx.archives.get(caller.actor, b, pendingViewFor(caller)))
    }

    if (n === 2 && a === 'tracks') {
      if (method === 'PATCH') {
        const track = library.requireTrack(b)
        if (caller.role !== 'owner' && !ownTrack(caller, track)) throw apiError('forbidden')
        const body = await readJsonObject(req)
        const changed = library.publicTrack(library.updateTrack(b, body), viewerOf(caller))
        return sendJson(req, res, 200, { track: changed }, sharedVersion())
      }
      if (method === 'DELETE') return deleteTrack(req, res, b, caller)
    }

    if (a === 'playlists' && playlistRoute(method, n, c)) {
      const { user, release } = await hold(res, caller.actor)
      try {
        // The answer once the change is applied, with the person's version.
        const done = (body) => sendJson(req, res, 200, body, userVersion(user))
        if (n === 1) {
          const body = await readJsonObject(req)
          return done({ playlist: user.createPlaylist(body) })
        }
        if (n === 2 && method === 'PATCH') {
          const body = await readJsonObject(req)
          return done({ playlist: user.updatePlaylist(b, body) })
        }
        if (n === 2) {
          user.deletePlaylist(b)
          return done({ ok: true })
        }
        const body = await readJsonObject(req)
        if (method === 'POST') return done({ playlist: user.addToPlaylist(b, body.trackIds, body.position) })
        return done({ playlist: user.removeFromPlaylist(b, body.indexes, body.ids, body.counts) })
      } finally {
        release()
      }
    }

    if (n === 1 && a === 'likes' && method === 'POST') return postLikes(req, res, caller)
    if (n === 2 && a === 'likes' && (method === 'PUT' || method === 'DELETE')) return putLike(req, res, b, query, caller)

    if (n === 1 && a === 'played' && method === 'POST') {
      const body = await readJsonObject(req)
      const { user, release } = await hold(res, caller.actor)
      try {
        user.played(body.trackId, body.context, body.at)
        return sendJson(req, res, 200, { ok: true }, userVersion(user))
      } finally {
        release()
      }
    }

    if (n === 3 && a === 'cover-for' && (method === 'PUT' || method === 'DELETE')) {
      // Every answer carries the caller's playlist covers: the person is held for both kinds.
      const { user, release } = await hold(res, caller.actor)
      try {
        if (method === 'PUT') return await putCustomCover(req, res, b, c, query, caller, user)
        checkCoverRights(caller, user, b, c)
        if (b === 'playlist') user.clearPlaylistCover(c)
        else library.clearCustomCover(b, c)
        return sendJson(req, res, 200, { covers: coversFor(user) }, coverVersion(user, b))
      } finally {
        release()
      }
    }

    if (n === 1 && a === 'profile') {
      if (method === 'GET' || method === 'HEAD') return sendJson(req, res, 200, profileView(caller))
      if (method === 'PATCH') return patchProfile(req, res, caller)
    }
    if (n === 2 && a === 'profile' && b === 'photo') {
      if (method === 'GET' || method === 'HEAD') return getPhoto(req, res, caller)
      if (method === 'PUT') return putPhoto(req, res, caller)
    }
    if (n === 2 && a === 'profile' && b === 'card' && method === 'PUT') return putCard(req, res, caller)
    if (n === 2 && a === 'profile' && b === 'social') {
      if (method === 'GET' || method === 'HEAD') return sendJson(req, res, 200, social.settings(socialCaller(caller)))
      if (method === 'PUT') return putSettings(req, res, caller)
    }
    if (n === 1 && a === 'activity' && method === 'PUT') return putActivity(req, res, caller)
    if (a === 'people' && (method === 'GET' || method === 'HEAD')) {
      if (n === 1) return getPeople(req, res, caller)
      if (n === 2) return getPerson(req, res, caller, b)
      if (n === 3 && c === 'photo') return getPersonPhoto(req, res, caller, b)
    }
    if (n === 1 && a === 'recents' && (method === 'GET' || method === 'HEAD')) return getRecents(req, res, caller, query)
    if (a === 'chat') return chatRoutes(req, res, seg, query, caller)
    if (a === 'comments') return commentRoutes(req, res, seg, query, caller)
    if (n === 2 && a === 'lyrics') return lyricsRoutes(req, res, b, query, caller)

    if (a === 'recovery') return recoveryRoutes(req, res, seg, caller)
    if (a === 'admin') return admin(req, res, seg.slice(1), caller)

    throw new HttpError(404, 'Risorsa non trovata')
  }

  // ------------------------------------------------------------------ health

  async function health (req, res) {
    noteSource()
    let diskFreeBytes = null
    try {
      const st = await fs.promises.statfs(ctx.dataDir)
      diskFreeBytes = st.bavail * st.bsize
    } catch {}
    let places
    if (ctx.places) {
      const counts = library.cardCounts()
      places = await ctx.places.health({ tracks: counts.tracks, awayTracks: counts.away })
    }
    return sendJson(req, res, 200, {
      ok: true,
      name: ctx.source.name,
      server: ctx.serverVersion,
      version: library.version,
      tracks: library.tracks.size,
      diskFreeBytes,
      places,
      ffmpeg: ctx.jobs.ffmpegAvailable,
      fpcalc: ctx.fingerprints.available,
      archives: { zip: true, sevenZip: ctx.sevenZip.available, rar: ctx.sevenZip.supports('rar') },
      details: ctx.source.details,
      social: SOCIAL_VERSION
    })
  }

  // ---------------------------------------------------------------- versions

  // The person's version and epoch once a change of its data is applied (a
  // change that changed nothing: the current ones). Only on a success: a refusal
  // goes through sendError, which drops every header set for it.
  function userVersion (user) {
    return { 'X-MPfy-User-Version': String(user.version), 'X-MPfy-User-Epoch': user.epoch }
  }

  // The shared version and epoch once a change of the library is applied.
  function sharedVersion () {
    return { 'X-MPfy-Version': String(library.version), 'X-MPfy-Epoch': library.epoch }
  }

  // A playlist cover is the person's data; a track or album cover is shared.
  function coverVersion (user, kind) {
    return kind === 'playlist' ? userVersion(user) : sharedVersion()
  }

  // ----------------------------------------------------------------- library

  // The body also carries the caller's role, the source's name and its details
  // switch: when the owner, the name or the switch change (the claim, set-owner,
  // a rename, source.json edited by hand), the shared version moves, so no
  // client keeps the old ones. A new owner is a reset (no delta crosses it): it
  // changes which tracks the owner acting without a profile calls its own.
  function noteSource () {
    const now = sourceState()
    if (now.owner === sourceSeen.owner && now.rest === sourceSeen.rest) return
    library.sourceChanged({ ownerMoved: now.owner !== sourceSeen.owner })
    sourceSeen = now
  }

  function rememberBody (key, entry) {
    bodyCache.set(key, entry)
    let bytes = 0
    for (const e of bodyCache.values()) bytes += e.json.length + (e.gzip ? e.gzip.length : 0)
    for (const [k, e] of bodyCache) {
      if (bodyCache.size <= 1 || (bodyCache.size <= BODY_CACHE && bytes <= BODY_CACHE_BYTES)) break
      bodyCache.delete(k)
      bytes -= e.json.length + (e.gzip ? e.gzip.length : 0)
    }
  }

  /**
   * GET /api/library. Without delta=1 or 2: today's answer, byte for byte (`have`
   * equal to the shared version: no tracks). With it: the versions' epochs, and
   * for each part (shared, the person's) either what moved since the version the
   * app holds, when the source can prove that version (have and he, uv and ue),
   * or the whole part; `delta` says which. The ETag names the caller, both
   * versions and both epochs, whatever was asked.
   */
  async function getLibrary (req, res, caller, query) {
    noteSource()
    const key = caller.actor
    // A merge into or out of the person ends first: its versions are the merged ones.
    await users.unlocked(key)
    const d = query.get('delta')
    const mode = d === '1' ? 1 : d === '2' ? 2 : 0
    if (mode === 0) legacy.note()
    // The owner acting without a profile (local, an older app) reads the owner's
    // data but answers with profileId null: its own tag.
    const tagOf = (version, userVersion, epoch, userEpoch) => 'W/"' + (caller.profileId || 'owner') + '.' + version + '.' + userVersion + '.' + epoch + '.' + userEpoch + '"'
    // The tag from what the source keeps of the person, loaded or not: a 304 loads nobody.
    const head = users.head(key)
    if (head !== null) {
      const early = tagOf(library.version, head.version, library.epoch, head.epoch)
      if (etagMatches(req.headers['if-none-match'], early)) {
        res.setHeader('ETag', early)
        res.setHeader('Cache-Control', 'no-cache')
        res.setHeader('Vary', 'Accept-Encoding')
        res.statusCode = 304
        res.end()
        return
      }
    }
    const { user, release } = await hold(res, key)
    try {
      return await libraryAnswer(req, res, caller, query, mode, user, tagOf)
    } finally {
      release()
    }
  }

  async function libraryAnswer (req, res, caller, query, mode, user, tagOf) {
    const a = {
      mode,
      caller,
      user,
      version: library.version,
      epoch: library.epoch,
      userVersion: user.version,
      userEpoch: user.epoch,
      tracks: true, // false: none (the app has them)
      shared: null, // what moved in the library, when sent as a delta
      mine: null // what moved in the person's data, when sent as a delta
    }
    const tag = tagOf(a.version, a.userVersion, a.epoch, a.userEpoch)
    res.setHeader('ETag', tag)
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Vary', 'Accept-Encoding')
    if (etagMatches(req.headers['if-none-match'], tag)) {
      res.statusCode = 304
      res.end()
      return
    }
    let asked
    if (mode === 0) {
      const have = query.get('have')
      a.tracks = !(have !== null && have === String(a.version))
      asked = 'o' + a.tracks
    } else {
      // A version or an epoch that is not well formed is simply not known.
      const have = versionParam(query, 'have')
      const he = epochParam(query, 'he')
      const uv = versionParam(query, 'uv')
      const ue = epochParam(query, 'ue')
      if (have === a.version && he === a.epoch) a.tracks = false
      else if (have !== null && he !== null) {
        const moved = library.changesSince(he, have)
        // A delta is never larger than the whole part.
        if (moved !== null && moved.changed.length <= library.tracks.size / 2) a.shared = moved
      }
      if (uv !== null && ue !== null) a.mine = user.changesSince(ue, uv, { edits: mode === 2 })
      asked = 'd' + mode + '.' + have + '.' + he + '.' + uv + '.' + ue
    }
    // Kept only when nothing moved while it was written: then it is the state at its tag.
    const still = () => library.version === a.version && user.version === a.userVersion
    return sendAnswer(req, res, { key: tag + '|' + asked, zip: acceptsGzip(req), still }, (out, signal) => writeLibrary(out, a, signal))
  }

  // The library answer, written piece by piece: the head with the versions taken
  // when it began, the tracks (none, all of them, or what moved), the person's part
  // (whole, or what moved), the covers, then who asks and the source. The walk
  // reads the live state: a change made meanwhile has a later version than the
  // head's, so the next delta brings it (an old app sees it at its next fetch).
  async function writeLibrary (out, a, signal) {
    const { user, caller } = a
    const viewer = viewerOf(caller)
    let text = '{"version":' + a.version + ',"userVersion":' + a.userVersion
    if (a.mode !== 0) {
      text += ',"epochs":' + JSON.stringify({ shared: a.epoch, user: a.userEpoch }) +
        ',"delta":' + JSON.stringify({ shared: a.shared !== null, user: a.mine !== null })
    }
    await put(out, text + ',"tracks":', signal)
    if (!a.tracks) {
      await put(out, 'null', signal)
    } else if (a.shared === null) {
      await library.writeTracks(out, viewer, { signal })
    } else {
      await put(out, '{"changed":[', signal)
      await putEach(out, a.shared.changed, (id) => {
        const t = library.getTrack(id)
        return t === null ? null : JSON.stringify(library.publicTrack(t, viewer))
      }, signal, TRACK_SLICE)
      await put(out, '],"removed":' + JSON.stringify(a.shared.removed) + '}', signal)
    }

    const m = a.mine
    let recents
    if (m === null) {
      await put(out, ',"playlists":[', signal)
      await putEach(out, user.playlists.values(), (p) => JSON.stringify(user.publicPlaylist(p)), signal)
      await put(out, '],"likes":', signal)
      if (!(await user.writeLikes(out, { signal }))) throw abortError()
      recents = user.recents.slice(0, MAX_RECENTS)
    } else {
      await put(out, ',"playlists":{"changed":[', signal)
      await putEach(out, m.playlists.changed, (id) => {
        const p = user.playlists.get(id)
        return p === undefined ? null : JSON.stringify(user.publicPlaylist(p))
      }, signal)
      await put(out, '],"removed":' + JSON.stringify(m.playlists.removed), signal)
      if (a.mode === 2) {
        await put(out, ',"edits":[', signal)
        await putEach(out, m.playlists.edits, ([id, e]) => JSON.stringify({ id, from: e.from, to: e.to, ops: e.ops, crc: e.crc }), signal)
        await put(out, ']', signal)
      }
      await put(out, '},"likes":{"added":[', signal)
      await putEach(out, m.likes.added, ([id, at]) => JSON.stringify({ id, at }), signal, LIKES_SLICE)
      await put(out, '],"removed":' + JSON.stringify(m.likes.removed) + '}', signal)
      recents = m.recents ? user.recents.slice(0, MAX_RECENTS) : null
    }

    await put(out, ',"recents":' + JSON.stringify(recents) + ',"covers":{', signal)
    if (a.tracks && a.shared === null) {
      // Every shared cover (one per track or album at most: written in pieces).
      for (const kind of ['track', 'album']) {
        await put(out, (kind === 'track' ? '"' : '},"') + kind + '":{', signal)
        await putEach(out, library.customCovers[kind], ([id, e]) => JSON.stringify(id) + ':' + JSON.stringify({ small: e.small, large: e.large }), signal, COVERS_SLICE)
      }
      await put(out, '},', signal)
    } else if (a.tracks) {
      const moved = {}
      for (const kind of ['track', 'album']) moved[kind] = movedCovers(a.shared.covers[kind], library.customCovers[kind])
      await put(out, JSON.stringify(moved).slice(1, -1) + ',', signal)
    }
    const playlist = m === null ? user.playlistCoversSnapshot() : movedCovers(m.covers, user.playlistCovers)
    await put(out, '"playlist":' + JSON.stringify(playlist) + '},"you":' + JSON.stringify({ profileId: caller.profileId, role: caller.role }) +
      ',"source":' + JSON.stringify({ name: ctx.source.name, named: ctx.source.named, details: ctx.source.details, social: SOCIAL_VERSION }) + '}', signal)
  }

  /**
   * An answer whose body `write(out, signal)` writes piece by piece (see
   * AnswerBody). A body that stays under CACHED_BODY is sent whole with its length:
   * cached under `key` when one is given and `still()` says nothing moved while it
   * was written, gzipped in one go when `zip`. A larger one is streamed as it is
   * written, never cached. A HEAD writes no body: its headers, with the length when
   * the body is cached. `signal` aborts when the reader goes away.
   */
  async function sendAnswer (req, res, { key = null, zip = false, still = () => true, headers = {} }, write) {
    res.setHeader('Content-Type', JSON_TYPE)
    if (!res.hasHeader('Cache-Control')) res.setHeader('Cache-Control', 'no-store')
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v)
    if (zip) res.setHeader('Content-Encoding', 'gzip')
    let entry = key !== null ? bodyCache.get(key) : undefined
    if (entry === undefined && req.method === 'HEAD') {
      res.statusCode = 200
      res.end()
      return
    }
    if (entry === undefined) {
      const ctrl = new AbortController()
      const gone = () => {
        if (!res.writableFinished) ctrl.abort()
      }
      res.on('close', gone)
      const out = new AnswerBody(res, zip, () => ctrl.abort())
      try {
        await write(out, ctrl.signal)
        await new Promise((resolve, reject) => {
          out.end((err) => (err ? reject(err) : resolve()))
        })
      } catch (err) {
        if (!ctrl.signal.aborted && !out.destroyed) throw err
        // The reader went away: nothing more to send.
        out.destroy()
        res.destroy()
        return
      } finally {
        res.off('close', gone)
      }
      if (out.streamed) return
      entry = { json: out.bytes(), gzip: null }
      if (key !== null && still()) rememberBody(key, entry)
    }
    let body = entry.json
    if (zip) {
      if (entry.gzip === null) entry.gzip = await gzip(entry.json)
      body = entry.gzip
    }
    res.statusCode = 200
    res.setHeader('Content-Length', body.length)
    res.end(req.method === 'HEAD' ? undefined : body)
  }

  // ------------------------------------------------------------------- likes

  // PUT and DELETE /api/likes/<trackId>: with ?brief=1 the answer is { ok: true };
  // without it, as before, the whole list (written in pieces).
  async function putLike (req, res, trackId, query, caller) {
    const { user, release } = await hold(res, caller.actor)
    try {
      if (req.method === 'PUT') user.like(trackId)
      else user.unlike(trackId)
      const headers = userVersion(user)
      if (query.get('brief') === '1') return sendJson(req, res, 200, { ok: true }, headers)
      return await sendAnswer(req, res, { headers }, async (out, signal) => {
        await put(out, '{"likes":', signal)
        if (!(await user.writeLikes(out, { signal }))) throw abortError()
        await put(out, '}', signal)
      })
    } finally {
      release()
    }
  }

  // POST /api/likes { add, remove }: many likes at once (the copy of a person's
  // data to another source), one change. A body that is not that shape is a
  // bad_request, whatever is wrong with it.
  async function postLikes (req, res, caller) {
    let body
    try {
      body = await readJson(req)
    } catch (err) {
      if (err instanceof HttpError && err.status === 400) throw apiError('bad_request')
      throw err
    }
    const { user, release } = await hold(res, caller.actor)
    try {
      const done = user.bulkLikes(body)
      return sendJson(req, res, 200, { ok: true, added: done.added, removed: done.removed }, userVersion(user))
    } finally {
      release()
    }
  }

  function coversFor (user) {
    const shared = library.coversSnapshot()
    return { track: shared.track, album: shared.album, playlist: user.playlistCoversSnapshot() }
  }

  // ------------------------------------------------------------------ stream

  async function stream (req, res, id, query) {
    const q = query.has('q') ? query.get('q') : 'max'
    if (!QUALITY_NAMES.includes(q)) throw new HttpError(400, "Qualita' non valida")
    if (!isTrackId(id)) throw new HttpError(404, 'Brano non trovato')
    const track = library.getTrack(id)
    if (track === null) throw new HttpError(404, 'Brano non trovato')
    const f = query.get('f')
    if (f !== null && f !== track.fileHash) throw apiError('version_gone')
    const who = req.mpfy.key || 'local'
    const continuation = isContinuation(req.headers.range)
    // A HEAD (how the web UI reads X-MPfy-Quality) only looks: it must neither
    // start a playback nor change what the current one gets.
    const peek = req.method === 'HEAD'

    // Nothing of it here now (its original on a memory card that is away, and
    // no ready level): never a 503, which says the whole source is down.
    const away = () => {
      ctx.places.maybeRecheck()
      return apiError('track_away')
    }
    let served = ctx.jobs.pick(track, q, { who, continuation, peek })
    if (served === null) throw away()
    let st = await placeStat(served)
    if (st === null && served.level !== 'max' && placeReadable(served)) {
      // The transcode vanished (deleted by hand): forget it and serve something else.
      ctx.jobs.forget(track.id, served.level)
      served = ctx.jobs.pick(track, q, { who, continuation: false, peek })
      if (served === null) throw away()
      st = await placeStat(served)
    }
    if (st === null && !placeReadable(served)) throw away()
    if (st === null) throw new HttpError(404, 'File del brano mancante')
    if (!peek) {
      if (served.level !== 'max') ctx.jobs.noteStreamed(track.id, served.level)
      // The playback keeps its representation for as long as this response lasts.
      res.once('close', ctx.jobs.hold(served))
    }

    const tag = served.tag
    res.setHeader('Content-Type', served.mime)
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('X-MPfy-Quality', served.level)
    // Only the original named by its file hash is for good. A transcode is not:
    // evicted and made again it is other bytes under the same URL, and a fallback
    // may give way to the asked level. Revalidate those.
    res.setHeader('Cache-Control', served.level === 'max' && q === 'max' && f === track.fileHash ? IMMUTABLE : 'no-cache')
    res.setHeader('ETag', tag)
    // A card file is read in chunks, each with its own short open: a paused
    // player holds nothing on the card, and the card leaving cuts the response.
    const open = served.place && served.place.kind === 'card' ? (start, end) => ctx.places.cardStream(served.place, served.file, start, end, res) : null
    return sendFile(req, res, served.file, st.size, tag, open)
  }

  function placeReadable (served) {
    return !served.place || served.place.readable
  }

  async function placeStat (served) {
    if (!served.place || served.place.kind !== 'card') return statOrNull(served.file)
    if (!served.place.readable) return null
    try {
      return await ctx.places.cardCall(() => ctx.places.io.stat(served.file))
    } catch {
      return null
    }
  }

  async function fingerprint (req, res, id, query) {
    const track = library.getTrack(id)
    if (track === null) throw new HttpError(404, 'Brano non trovato')
    const f = query.get('f')
    if (f !== null && f !== track.fileHash) throw apiError('version_gone')
    const fp = track.fpState === 'ok' ? ctx.fingerprints.read(track.fileHash) : null
    if (fp === null) throw new HttpError(404, 'Impronta non disponibile')
    res.setHeader('Cache-Control', f === track.fileHash ? IMMUTABLE : 'no-cache')
    return sendJson(req, res, 200, { trackId: track.id, fileHash: track.fileHash, d: fp.duration, step: STEP, fp: packItems(fp.items).toString('base64') })
  }

  // ------------------------------------------------------------------- cover

  async function cover (req, res, coverId, query) {
    const size = query.has('size') ? query.get('size') : null
    if (size !== null && !COVER_SIZES.includes(size)) throw new HttpError(400, 'Dimensione non valida')
    if (!isCoverId(coverId)) throw new HttpError(404, 'Copertina non trovata')
    const found = library.coverPath(coverId, size)
    if (found === null) throw new HttpError(404, 'Copertina non trovata')
    const st = await statOrNull(found.file)
    if (st === null) throw new HttpError(404, 'Copertina non trovata')
    let cache = IMMUTABLE
    if (size !== null && !found.sized && library.isEmbeddedCover(coverId)) {
      // The resized version does not exist (yet): serve the original, and make it.
      cache = SIZE_FALLBACK_CACHE
      ctx.jobs.requestCoverSizes(coverId)
    }
    const tag = '"' + coverId + (found.sized ? '.' + size : '') + '"'
    res.setHeader('Content-Type', COVER_MIME[found.ext])
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('Cache-Control', cache)
    res.setHeader('ETag', tag)
    return sendFile(req, res, found.file, st.size, tag)
  }

  // Track and album covers are shared: the owner any, a member its own; playlist
  // covers belong to the person.
  function checkCoverRights (caller, user, kind, id) {
    if (kind === 'playlist') {
      user.playlist(id)
      return
    }
    library.checkSharedCoverTarget(kind, id)
    if (caller.role === 'owner') return
    if (kind === 'track') {
      const t = library.getTrack(id)
      if (t === null || !ownTrack(caller, t)) throw apiError('forbidden')
    } else if (!ownAlbum(caller, id)) {
      throw apiError('forbidden')
    }
  }

  async function putCustomCover (req, res, kind, id, query, caller, user) {
    const size = query.get('size')
    if (!COVER_SIZES.includes(size)) throw new HttpError(400, 'Dimensione non valida')
    checkCoverRights(caller, user, kind, id) // before reading the body
    const data = await readBody(req, MAX_CUSTOM_COVER)
    const coverId = saveCoverBytes(data, library.coversDir)
    if (coverId === null) throw new HttpError(415, "L'immagine non e' un JPEG, PNG o WebP")
    if (kind === 'playlist') user.setPlaylistCover(id, size, coverId)
    else library.setCustomCover(kind, id, size, coverId)
    return sendJson(req, res, 200, { covers: coversFor(user) }, coverVersion(user, kind))
  }

  // ------------------------------------------------------------------ tracks

  // The answer carries the shared version only: the track leaving people's data
  // reaches them in their next delta.
  async function deleteTrack (req, res, id, caller) {
    const track = library.requireTrack(id)
    if (caller.role === 'owner') {
      await ctx.removeTrackFile(track)
      return sendJson(req, res, 200, { ok: true, deleted: true }, sharedVersion())
    }
    if (!ownTrack(caller, track)) throw apiError('forbidden')
    let left = track.uploaders.length
    for (const who of viewerOf(caller)) if (track.uploaders.includes(who)) left = library.removeUploader(id, who)
    if (left > 0) return sendJson(req, res, 200, { ok: true, deleted: false }, sharedVersion())
    // Someone may make it theirs while the job reading it stops: then it stays.
    const deleted = await ctx.removeTrackFile(library.getTrack(id), (t) => t.uploaders.length === 0)
    return sendJson(req, res, 200, { ok: true, deleted }, sharedVersion())
  }

  // ----------------------------------------------------------------- uploads

  async function uploadSingle (req, res, rawName, caller) {
    const name = rawName
    const got = await receiveUpload(req, { tmpDir: library.tmpDir, maxBytes: ctx.maxUpload, disk: ctx.disk })
    const result = await ctx.pipeline.ingest({ file: got.tmp, hash: got.hash, size: got.size, name: cleanFileName(name), caller })
    return sendJson(req, res, result.outcome === 'archive' ? 202 : 200, renderResult(result, library, viewerOf(caller), pendingRecordView(caller)), sharedVersion())
  }

  async function uploads (req, res, seg, query, caller) {
    const method = req.method
    const n = seg.length
    const id = seg[1]
    const sessions = ctx.sessions
    if (n === 1 && method === 'POST') {
      const body = await readJsonObject(req)
      const { status, body: answer } = await sessions.create({ ...caller, clientKey: caller.key }, body)
      return sendJson(req, res, status, answer)
    }
    if (n === 1 && (method === 'GET' || method === 'HEAD')) return sendJson(req, res, 200, sessions.list(caller))
    if (n === 2 && (method === 'GET' || method === 'HEAD')) return sendJson(req, res, 200, sessions.get(caller, id))
    if (n === 2 && method === 'DELETE') {
      sessions.cancel(caller, id)
      return sendJson(req, res, 200, { ok: true })
    }
    if (n === 2 && method === 'PUT') {
      const answer = await sessions.put(req, caller, id, query.get('offset'))
      if (answer === null) return // taken over by a newer request, or cut
      // The piece that finishes the session carries the upload's result.
      return sendJson(req, res, 200, answer, answer.done === true ? sharedVersion() : {})
    }
    throw new HttpError(404, 'Risorsa non trovata')
  }

  function pendingRecordView (caller) {
    const viewer = viewerOf(caller)
    return (rec) => defaultPendingView(rec, library, viewer)
  }

  function pendingViewFor (caller) {
    const viewer = viewerOf(caller)
    return (pendingId) => {
      const rec = ctx.pending.byId(pendingId)
      return rec === null ? null : defaultPendingView(rec, library, viewer)
    }
  }

  async function answerPending (req, res, id, caller) {
    const body = await readJsonObject(req)
    if (body.keep !== 'best' && body.keep !== 'both') throw new HttpError(400, 'Scelta non valida')
    const rec = ctx.pending.get(caller.actor, id)
    if (!ctx.pending.take(id)) throw apiError('pending_gone')
    const result = await ctx.decidePending(rec, body.keep, caller)
    return sendJson(req, res, 200, renderResult(result, library, viewerOf(caller)), sharedVersion())
  }

  // ----------------------------------------------------------------- profile

  function profileView (caller) {
    const rec = caller.profileId !== null ? ctx.profiles.get(caller.profileId) : null
    let recovery = null
    if (caller.profileId !== null && caller.key) recovery = ctx.recovery.deviceInfo(caller.profileId, caller.key)
    return {
      profileId: caller.profileId,
      name: rec ? rec.name : '',
      nameUpdatedAt: rec ? rec.nameUpdatedAt : 0,
      photo: rec ? rec.photo : null,
      photoUpdatedAt: rec ? rec.photoUpdatedAt : 0,
      role: caller.role,
      recovery,
      source: { name: ctx.source.name, named: ctx.source.named, ownerProfileId: ctx.source.ownerProfileId, details: ctx.source.details },
      social: social.stamps(caller.profileId)
    }
  }

  async function patchProfile (req, res, caller) {
    if (caller.profileId === null) throw apiError('no_profile')
    const body = await readJsonObject(req)
    const name = cleanName(body.name)
    if (name === null) throw apiError('bad_name')
    if (typeof body.nameUpdatedAt !== 'number' || !Number.isFinite(body.nameUpdatedAt)) throw new HttpError(400, 'Momento non valido')
    ctx.profiles.setName(caller.profileId, name, body.nameUpdatedAt)
    return sendJson(req, res, 200, profileView(caller))
  }

  // The photo travels like the name: { photo: base64 of the JPEG or null,
  // photoUpdatedAt }, kept only when newer; the answer is the profile either way.
  async function putPhoto (req, res, caller) {
    if (caller.profileId === null) throw apiError('no_profile')
    const body = await readJsonObject(req, MAX_PHOTO_JSON)
    const bytes = photoBytes(body.photo)
    if (bytes === undefined) throw apiError('bad_photo')
    if (typeof body.photoUpdatedAt !== 'number' || !Number.isFinite(body.photoUpdatedAt)) throw new HttpError(400, 'Momento non valido')
    ctx.profiles.setPhoto(caller.profileId, bytes, body.photoUpdatedAt)
    return sendJson(req, res, 200, profileView(caller))
  }

  // The caller's own photo, never another profile's.
  async function getPhoto (req, res, caller) {
    const file = caller.profileId !== null ? ctx.profiles.photoFile(caller.profileId) : null
    // Named by its hash, read with the file's name before anything can change it.
    const tag = file !== null ? '"' + ctx.profiles.get(caller.profileId).photo + '"' : null
    const st = file !== null ? await statOrNull(file) : null
    if (st === null) throw new HttpError(404, 'Foto non trovata')
    res.setHeader('Content-Type', 'image/jpeg')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('ETag', tag)
    return sendFile(req, res, file, st.size, tag)
  }

  // ------------------------------------------------------------------ social

  // A social route answers only a caller with a profile: local requests, older
  // apps of the owner and guests get 403 no_profile.
  function socialCaller (caller) {
    if (caller.profileId === null) throw apiError('no_profile')
    return caller.profileId
  }

  // The profiles of the source not removed: who may be listed.
  function activeIds () {
    return new Set(ctx.profiles.active().map((p) => p.profileId))
  }

  async function putCard (req, res, caller) {
    const pid = socialCaller(caller)
    social.take(pid, 'card')
    const card = await readJsonObject(req, MAX_CARD_JSON)
    return sendJson(req, res, 200, { card: social.putCard(pid, card) })
  }

  async function putSettings (req, res, caller) {
    const pid = socialCaller(caller)
    social.take(pid, 'card')
    const body = await readJsonObject(req, MAX_SOCIAL_JSON)
    return sendJson(req, res, 200, social.putSettings(pid, body))
  }

  async function putActivity (req, res, caller) {
    const pid = socialCaller(caller)
    social.take(pid, 'activity')
    const body = await readJsonObject(req, MAX_ACTIVITY_JSON)
    social.activity(pid, body)
    return sendJson(req, res, 200, { ok: true })
  }

  // The people answers carry an ETag of the body without its time (which moves at
  // every request), so an unchanged list is a 304. The body is built anyway: it is
  // small.
  function sendPeople (req, res, body) {
    const { time, ...rest } = body
    const tag = '"p' + crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex').slice(0, 16) + '"'
    res.setHeader('ETag', tag)
    res.setHeader('Cache-Control', 'no-cache')
    if (etagMatches(req.headers['if-none-match'], tag)) {
      res.statusCode = 304
      res.end()
      return
    }
    return sendJson(req, res, 200, body)
  }

  function getPeople (req, res, caller) {
    const pid = socialCaller(caller)
    return sendPeople(req, res, social.people(pid, activeIds()))
  }

  function getPerson (req, res, caller, target) {
    const pid = socialCaller(caller)
    const page = isProfileId(target) ? social.person(pid, target, activeIds()) : null
    if (page === null) throw apiError('no_person')
    return sendPeople(req, res, page)
  }

  // The photo of a person's card, while the caller may see that person, and only
  // when it is the photo this source holds for them.
  async function getPersonPhoto (req, res, caller, target) {
    const pid = socialCaller(caller)
    const hash = isProfileId(target) ? social.photoFor(pid, target, activeIds()) : null
    const rec = hash !== null ? ctx.profiles.get(target) : null
    const file = rec !== null && rec.photo === hash ? ctx.profiles.photoFile(target) : null
    const st = file !== null ? await statOrNull(file) : null
    if (st === null) throw new HttpError(404, 'Foto non trovata')
    const tag = '"' + hash + '"'
    res.setHeader('Content-Type', 'image/jpeg')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('ETag', tag)
    return sendFile(req, res, file, st.size, tag)
  }

  // The caller's own plays, as the library's user data: newest first, older than
  // `before`, `limit` at a time (100 by default, 200 at most).
  async function getRecents (req, res, caller, query) {
    const before = wholeParam(query, 'before')
    const limit = wholeParam(query, 'limit')
    if (before === undefined || limit === undefined || limit === 0) throw apiError('bad_request')
    const { user, release } = await hold(res, caller.actor)
    try {
      const page = user.recentsPage(before, limit === null ? RECENTS_PAGE : Math.min(limit, MAX_RECENTS_PAGE))
      return sendJson(req, res, 200, page)
    } finally {
      release()
    }
  }

  // ------------------------------------------------------------------- chats

  async function chatRoutes (req, res, seg, query, caller) {
    const method = req.method
    const read = method === 'GET' || method === 'HEAD'
    const n = seg.length
    const [, b, c, d, e] = seg
    if (n === 2 && b === 'conversations' && read) return getConversations(req, res, caller, query)
    if (n === 2 && b === 'group' && read) {
      socialCaller(caller)
      return sendJson(req, res, 200, { id: chat.groupId, recipients: social.groupRecipients(activeIds()) })
    }
    if (n === 3 && b === 'group' && c === 'access' && method === 'PUT') return putAccess(req, res, caller)
    if (n >= 3 && HEX32_RE.test(b)) {
      if (n === 3 && c === 'messages' && read) return getMessages(req, res, caller, b, query)
      if (n === 3 && c === 'messages' && method === 'POST') return postMessage(req, res, caller, b)
      if (n === 4 && c === 'messages' && method === 'DELETE') return deleteMessage(req, res, caller, b, d)
      if (n === 5 && c === 'messages' && e === 'playlist' && read) return getSharedPlaylist(req, res, caller, b, d)
      if (n === 3 && c === 'read' && method === 'PUT') return putRead(req, res, caller, b)
    }
    throw new HttpError(404, 'Risorsa non trovata')
  }

  // Whose records `pid` is not served (the people it blocked), and a name of that state.
  function hiddenOf (pid) {
    return { hidden: (from) => social.blocks(pid, from), stamp: social.blockStamp(pid) }
  }

  function msgOf (e, box) {
    if (e.k === 'd') return { id: e.id, seq: e.seq, from: e.msg.from, at: e.msg.at, deleted: true }
    return { id: e.id, seq: e.seq, from: e.from, at: e.at, box }
  }

  // The conversations of `pid` as their metadata (no box read): what the ETag covers.
  function conversationsView (pid) {
    const { hidden, stamp } = hiddenOf(pid)
    const items = chat.conversationsOf(pid, hidden).map((x) => {
      const s = x.conv !== null ? chat.summary(x.conv, pid, hidden, stamp) : { seq: 0, last: null, unread: 0, read: null }
      return { x, s }
    })
    items.sort((p, q) => (p.x.id < q.x.id ? -1 : 1))
    const meta = items.map(({ x, s }) => [x.id, x.kind, x.with || null, s.seq, s.last === null ? null : [s.last.id, s.last.seq, s.last.from, s.last.at], s.unread, s.read])
    const tag = '"c' + crypto.createHash('sha256').update(JSON.stringify([chat.groupId, meta])).digest('hex').slice(0, 16) + '"'
    return { tag, items }
  }

  // GET /api/chat/conversations[?wait=<s>]: with `wait` and an If-None-Match that
  // names what the caller has, the answer waits for a change (up to 25 s), then
  // comes as usual: a 304 when nothing changed.
  async function getConversations (req, res, caller, query) {
    const pid = socialCaller(caller)
    const wait = wholeParam(query, 'wait')
    if (wait === undefined) throw apiError('bad_request')
    let view = conversationsView(pid)
    const asked = req.headers['if-none-match']
    if (wait !== null && wait > 0 && etagMatches(asked, view.tag)) {
      let gone = false
      res.once('close', () => { gone = true })
      const until = Date.now() + Math.min(wait * 1000, MAX_WAIT_MS)
      while (!gone && Date.now() < until) {
        const why = await chat.waitFor(pid, until - Date.now())
        view = conversationsView(pid)
        if (why !== 'change' || !etagMatches(asked, view.tag)) break
      }
      if (gone) return
    }
    res.setHeader('ETag', view.tag)
    res.setHeader('Cache-Control', 'no-cache')
    if (etagMatches(asked, view.tag)) {
      res.statusCode = 304
      res.end()
      return
    }
    const conversations = []
    for (const { x, s } of view.items) {
      let last = null
      if (s.last !== null) {
        const boxes = await chat.readBoxes(x.conv, [s.last], pid)
        if (boxes.has(s.last.id)) last = msgOf(s.last, boxes.get(s.last.id))
      }
      const conv = { id: x.id, kind: x.kind }
      if (x.kind === 'direct') conv.with = x.with
      Object.assign(conv, { seq: s.seq, last, unread: s.unread, read: s.read })
      conversations.push(conv)
    }
    return sendJson(req, res, 200, { time: social.now(), group: chat.groupId, conversations })
  }

  async function getMessages (req, res, caller, cid, query) {
    const pid = socialCaller(caller)
    const after = wholeParam(query, 'after')
    const before = wholeParam(query, 'before')
    const limit = wholeParam(query, 'limit')
    if (after === undefined || before === undefined || limit === undefined || limit === 0 || (after !== null && before !== null)) throw apiError('bad_request')
    const conv = chat.get(cid)
    if (conv === null || !chat.isParty(conv, pid)) return sendJson(req, res, 200, { time: social.now(), seq: 0, messages: [], more: false })
    const { hidden, stamp } = hiddenOf(pid)
    const page = chat.page(conv, pid, hidden, stamp, { after, before, limit: limit === null ? PAGE : Math.min(limit, MAX_PAGE) })
    const boxes = await chat.readBoxes(conv, page.list, pid)
    const messages = []
    for (const e of page.list) {
      if (e.k === 'd') messages.push(msgOf(e))
      else if (boxes.has(e.id)) messages.push(msgOf(e, boxes.get(e.id)))
    }
    return sendJson(req, res, 200, { time: social.now(), seq: page.seq, messages, more: page.more })
  }

  // POST /api/chat/<cid>/messages { id, at, with?, boxes, playlist? }. The limit
  // of the body follows from the conversation, known before the body is read.
  async function postMessage (req, res, caller, cid) {
    const pid = socialCaller(caller)
    social.take(pid, 'chat')
    const active = activeIds()
    const group = cid === chat.groupId
    const recipients = group ? social.groupRecipients(active) : null
    const count = group ? recipients.length + (recipients.includes(pid) ? 0 : 1) : 2
    const msg = chat.readPost(await readJsonObject(req, BODY_BASE + BODY_PER_RECIPIENT * count))
    if (!Object.prototype.hasOwnProperty.call(msg.boxes, pid)) throw apiError('bad_message')
    let a = null
    let b = null
    let keep
    if (group) {
      if (msg.with !== null) throw apiError('bad_message')
      const allowed = new Set(recipients)
      keep = (p) => allowed.has(p)
    } else {
      if (msg.with === null || msg.with === pid) throw apiError('bad_message')
      if (!active.has(msg.with) || social.seen(pid, msg.with) === null) throw apiError('no_person')
      if (directIdOf(pid, msg.with) !== cid) throw apiError('bad_message')
      a = pid < msg.with ? pid : msg.with
      b = pid < msg.with ? msg.with : pid
      // Written to someone who blocked the writer: their box goes, it looks sent.
      const dropped = social.blocks(msg.with, pid)
      keep = (p) => p === msg.with && !dropped
    }
    const to = [pid, ...Object.keys(msg.boxes).filter((p) => p !== pid && keep(p))]
    const pl = msg.pl !== null && users.hasPlaylist(pid, msg.pl) ? msg.pl : null
    const r = await chat.post(cid, group ? 'group' : 'direct', a, b, pid, { id: msg.id, at: msg.at, pl, to, boxes: to.map((p) => msg.boxes[p]) })
    if (r.created) return sendJson(req, res, 201, { message: msgOf(r.entry, msg.boxes[pid]) })
    if (r.entry.k === 'd') return sendJson(req, res, 200, { message: msgOf(r.entry) })
    const boxes = await chat.readBoxes(r.conv, [r.entry], pid)
    return sendJson(req, res, 200, { message: msgOf(r.entry, boxes.get(r.entry.id) || null) })
  }

  async function deleteMessage (req, res, caller, cid, id) {
    const pid = socialCaller(caller)
    social.take(pid, 'chat')
    const conv = chat.get(cid)
    if (conv === null || !HEX32_RE.test(id) || !chat.isParty(conv, pid)) throw apiError('message_gone')
    await chat.remove(conv, pid, id)
    return sendJson(req, res, 200, { ok: true })
  }

  async function putRead (req, res, caller, cid) {
    const pid = socialCaller(caller)
    social.take(pid, 'chat')
    const mark = chat.readMark(await readJsonObject(req, MAX_SMALL_JSON))
    const conv = chat.get(cid)
    if (conv === null || !conv.exists || !chat.isParty(conv, pid)) throw apiError('message_gone')
    const kept = await chat.read(conv, pid, mark)
    return sendJson(req, res, 200, { read: { at: kept.at, id: kept.id } })
  }

  // PUT /api/chat/group/access { at, sig }: the caller's silent entry in this
  // source's group, signed with the key of its card.
  async function putAccess (req, res, caller) {
    const pid = socialCaller(caller)
    social.take(pid, 'chat')
    const body = await readJsonObject(req, MAX_SMALL_JSON)
    if (Object.keys(body).some((k) => k !== 'at' && k !== 'sig') || typeof body.at !== 'number' || typeof body.sig !== 'string' || !SIG_RE.test(body.sig)) throw apiError('bad_request')
    if (!Number.isSafeInteger(body.at) || body.at <= 0 || body.at > social.now() + AHEAD_MS) throw apiError('bad_time')
    const card = social.cardOf(pid)
    if (card === null || !accessValid(card.signPublicKey, pid, chat.groupId, body.at, body.sig)) throw apiError('bad_card')
    const kept = await chat.access(pid, { at: body.at, sig: body.sig })
    return sendJson(req, res, 200, { access: { at: kept.at } })
  }

  // The playlist a message shares, as its sender keeps it now: to the people the
  // message is for, while it lives. Read only.
  async function getSharedPlaylist (req, res, caller, cid, id) {
    const pid = socialCaller(caller)
    const conv = chat.get(cid)
    const e = conv !== null && HEX32_RE.test(id) ? conv.byId.get(id) : undefined
    if (e === undefined || e.k !== 'm' || e.gone || !e.to.includes(pid) || (e.from !== pid && social.blocks(pid, e.from))) throw apiError('message_gone')
    // The sender's summary says whether the playlist is there: nobody loaded for a gone one.
    if (e.pl === null || !users.hasPlaylist(e.from, e.pl)) throw new HttpError(404, 'Playlist non trovata')
    const { user, release } = await hold(res, e.from)
    try {
      return sharedPlaylistAnswer(req, res, user, e)
    } finally {
      release()
    }
  }

  function sharedPlaylistAnswer (req, res, user, e) {
    const p = user.playlists.get(e.pl)
    if (p === undefined) throw new HttpError(404, 'Playlist non trovata')
    const covers = user.playlistCovers.get(e.pl)
    const shown = user.publicPlaylist(p)
    const body = { playlist: { id: shown.id, name: shown.name, trackIds: shown.trackIds, updatedAt: shown.updatedAt, cover: covers ? (covers.large || covers.small || null) : null } }
    const tag = '"l' + crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16) + '"'
    res.setHeader('ETag', tag)
    res.setHeader('Cache-Control', 'no-cache')
    if (etagMatches(req.headers['if-none-match'], tag)) {
      res.statusCode = 304
      res.end()
      return
    }
    return sendJson(req, res, 200, body)
  }

  // ---------------------------------------------------------------- comments

  // An answer with an ETag of its body (built anyway: it is small), 304 when the
  // caller has it already.
  function sendTagged (req, res, body, prefix) {
    const tag = '"' + prefix + crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16) + '"'
    res.setHeader('ETag', tag)
    res.setHeader('Cache-Control', 'no-cache')
    if (etagMatches(req.headers['if-none-match'], tag)) {
      res.statusCode = 304
      res.end()
      return
    }
    return sendJson(req, res, 200, body)
  }

  // A comment as served: its author's name from their card, else from profiles.json
  // (`profileOf`: one look at it for a whole answer).
  function commentOut (c, profileOf = ctx.profiles.lookup()) {
    const card = social.cardOf(c.from)
    const p = card === null ? profileOf(c.from) : null
    const name = card !== null ? card.name : p !== null ? p.name : ''
    return { id: c.id, trackId: c.trackId, from: c.from, name, at: c.at, text: c.text }
  }

  async function commentRoutes (req, res, seg, query, caller) {
    const method = req.method
    const n = seg.length
    const pid = socialCaller(caller)
    if (n === 1 && (method === 'GET' || method === 'HEAD')) return getComments(req, res, pid, query)
    if (n === 1 && method === 'POST') return postComment(req, res, pid)
    if (n === 2 && method === 'DELETE') {
      social.take(pid, 'comment')
      // The owner moderates the comments of this source (another may hold a copy).
      ctx.comments.remove(pid, seg[1], caller.role === 'owner')
      return sendJson(req, res, 200, { ok: true })
    }
    throw new HttpError(404, 'Risorsa non trovata')
  }

  // GET /api/comments?tracks=<id>,<id>: 1 to 20 trackIds, those not held here
  // left out; what the caller may see, newest first.
  function getComments (req, res, pid, query) {
    const asked = query.has('tracks') ? query.get('tracks').split(',') : []
    if (asked.length === 0 || asked.length > MAX_ASKED || !asked.every(isTrackId)) throw apiError('bad_request')
    const held = [...new Set(asked)].filter((id) => library.getTrack(id) !== null)
    const hidden = (from) => social.invisible(from) || social.blocks(pid, from)
    // profiles.json looked at once for the whole answer, not once per comment.
    const profileOf = ctx.profiles.lookup()
    const removed = (from) => {
      const p = profileOf(from)
      return p !== null && p.removedAt !== null
    }
    return sendTagged(req, res, { comments: ctx.comments.list(held, pid, hidden, removed).map((c) => commentOut(c, profileOf)) }, 'k')
  }

  // POST /api/comments { id, trackId, at, text }: 201 for a new comment, 200 with
  // the stored one when the caller had one there (replaced when newer).
  async function postComment (req, res, pid) {
    social.take(pid, 'comment')
    const body = await readJsonObject(req, MAX_COMMENT_JSON)
    const r = ctx.comments.post(pid, body, (id) => library.getTrack(id) !== null)
    return sendJson(req, res, r.created ? 201 : 200, { comment: commentOut(r.comment) })
  }

  // ------------------------------------------------------------------ lyrics

  // GET (any profile), PUT (an .lrc or a plain text; ?beside=1: only for a track
  // without synced lyrics) and DELETE of a track's lyrics. Writing takes the owner,
  // or a member whose track it is.
  async function lyricsRoutes (req, res, trackId, query, caller) {
    const method = req.method
    if (method === 'GET' || method === 'HEAD') {
      socialCaller(caller)
      const got = isTrackId(trackId) ? await ctx.lyrics.read(trackId) : null
      if (got === null) throw apiError('no_lyrics')
      res.setHeader('ETag', got.tag)
      res.setHeader('Cache-Control', 'no-cache')
      if (etagMatches(req.headers['if-none-match'], got.tag)) {
        res.statusCode = 304
        res.end()
        return
      }
      return sendJson(req, res, 200, got.body)
    }
    if (method !== 'PUT' && method !== 'DELETE') throw new HttpError(404, 'Risorsa non trovata')
    const track = isTrackId(trackId) ? library.getTrack(trackId) : null
    if (track === null) throw apiError('version_gone')
    if (caller.role !== 'owner' && !ownTrack(caller, track)) throw apiError('forbidden')
    if (method === 'DELETE') {
      ctx.lyrics.remove(trackId)
      return sendJson(req, res, 200, { ok: true }, sharedVersion())
    }
    let text
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(await readBody(req, MAX_LYRICS_BYTES))
    } catch (err) {
      if (err instanceof HttpError && err.status !== 413) throw err
      throw apiError('bad_lyrics')
    }
    let got
    try {
      got = await ctx.lyrics.put(trackId, text, { beside: query.get('beside') === '1' })
    } catch (err) {
      if (err instanceof LyricsError) throw apiError('bad_lyrics')
      throw err
    }
    if (got === null) throw apiError('version_gone')
    res.setHeader('ETag', got.tag)
    return sendJson(req, res, 200, got.body, sharedVersion())
  }

  // The owner renames the source and turns the details from the network on or
  // off; the AcoustID key only from the source itself.
  async function patchSource (req, res, caller) {
    ownerOnly(caller)
    const body = await readJsonObject(req)
    const has = (k) => Object.prototype.hasOwnProperty.call(body, k)
    if (!has('name') && !has('details') && !has('acoustidKey')) throw apiError('bad_request')
    if (has('acoustidKey') && !caller.local) throw apiError('forbidden')
    const patch = {}
    if (has('name')) {
      const name = cleanName(body.name)
      if (name === null) throw apiError('bad_name')
      patch.name = name
      patch.named = true
    }
    if (has('details')) {
      if (typeof body.details !== 'boolean') throw apiError('bad_request')
      patch.details = body.details
    }
    if (has('acoustidKey')) {
      const key = body.acoustidKey
      if (key !== null && (typeof key !== 'string' || !ACOUSTID_KEY_RE.test(key))) throw apiError('bad_request')
      patch.acoustidKey = key
    }
    ctx.source.update(patch)
    if (ctx.details) ctx.details.sourceChanged()
    if (ctx.lyrics) ctx.lyrics.sourceChanged()
    return sendJson(req, res, 200, { source: { name: ctx.source.name, named: ctx.source.named, details: ctx.source.details } })
  }

  // ---------------------------------------------------------------- recovery

  async function recoveryRoutes (req, res, seg, caller) {
    const method = req.method
    const n = seg.length
    const recovery = ctx.recovery
    if (n === 1 && (method === 'PUT' || method === 'DELETE')) {
      if (caller.profileId === null || !caller.key) throw apiError('no_profile')
      if (method === 'DELETE') {
        recovery.deleteDevice(caller.profileId, caller.key)
        return sendJson(req, res, 200, { ok: true })
      }
      const body = validRecoveryBody(await readJsonObject(req))
      if (body === null) throw new HttpError(400, 'Dati di recupero non validi')
      const client = ctx.clients.get(caller.key)
      const updatedAt = recovery.put(caller.profileId, caller.key, body, client ? client.name : '')
      return sendJson(req, res, 200, { ok: true, updatedAt })
    }
    if (n === 2 && seg[1] === 'profiles' && (method === 'GET' || method === 'HEAD')) {
      const entries = []
      for (const e of recovery.entries()) {
        const p = ctx.profiles.get(e.profileId)
        if (p === null || p.removedAt !== null) continue
        entries.push({ profileId: e.profileId, name: p.name, device: e.device, deviceName: e.deviceName, updatedAt: e.updatedAt })
      }
      return sendJson(req, res, 200, { entries })
    }
    const profileId = seg[1]
    const device = seg[2]
    if (n === 3 && (method === 'GET' || method === 'HEAD')) {
      const params = isProfileId(profileId) && isPublicKey(device) ? recovery.params(profileId, device) : null
      if (params === null) throw apiError('no_recovery')
      return sendJson(req, res, 200, params)
    }
    if (n === 4 && seg[3] === 'release' && method === 'POST') {
      const body = await readJsonObject(req)
      if (typeof body.verifier !== 'string' || !/^[0-9a-f]{64}$/.test(body.verifier)) throw new HttpError(400, 'Verifica non valida')
      if (!isProfileId(profileId) || !isPublicKey(device)) throw apiError('no_recovery')
      const r = recovery.release(profileId, device, Buffer.from(body.verifier, 'hex'))
      if (r.missing) throw apiError('no_recovery')
      if (r.locked) throw apiError('locked', { retryAt: r.retryAt })
      if (r.wrong) throw apiError('wrong_password', { triesLeft: r.triesLeft })
      return sendJson(req, res, 200, { blob: r.blob, updatedAt: r.updatedAt })
    }
    throw new HttpError(404, 'Risorsa non trovata')
  }

  // ------------------------------------------------------------------- admin

  async function admin (req, res, seg, caller) {
    const method = req.method
    const [a, b] = seg
    const n = seg.length

    if (n === 1 && a === 'code' && method === 'GET') {
      return sendJson(req, res, 200, { code: ctx.pairing.code })
    }
    if (n === 2 && a === 'code' && b === 'rotate' && method === 'POST') {
      ownerOnly(caller)
      const code = await ctx.rotateCode()
      return sendJson(req, res, 200, { code })
    }
    if (n === 1 && a === 'source' && method === 'PATCH') return patchSource(req, res, caller)
    if (n === 1 && a === 'storage' && (method === 'GET' || method === 'HEAD')) {
      ownerOnly(caller)
      return sendJson(req, res, 200, await storageView(ctx))
    }
    if (n === 1 && a === 'storage' && method === 'PUT') {
      ownerOnly(caller)
      const body = await readJsonObject(req)
      return sendJson(req, res, 200, await storageAction(ctx, body))
    }
    if (n === 1 && a === 'clients' && method === 'GET') {
      const transport = ctx.transport()
      const connected = new Set(transport ? transport.connectedClients() : [])
      const who = caller.key
      let list = ctx.clients.list()
      if (caller.role !== 'owner') list = list.filter((cl) => cl.profileId === caller.profileId)
      const clients = list.map((cl) => {
        const p = cl.profileId ? ctx.profiles.get(cl.profileId) : null
        return {
          publicKey: cl.publicKey,
          name: cl.name,
          addedAt: cl.addedAt,
          connected: connected.has(cl.publicKey),
          you: cl.publicKey === who,
          profileId: cl.profileId || null,
          profileName: p ? p.name : null,
          legacy: cl.legacy === true
        }
      })
      return sendJson(req, res, 200, { clients })
    }
    if (n === 2 && a === 'clients' && method === 'DELETE') {
      const who = caller.key
      let key = String(b)
      const self = key === 'self'
      if (self) {
        if (who === null) throw new HttpError(400, 'Questa richiesta non arriva da un dispositivo collegato')
        key = who
      }
      key = key.toLowerCase()
      if (!isPublicKey(key)) throw new HttpError(400, 'Chiave pubblica non valida')
      if (caller.role !== 'owner' && key !== who) {
        const target = ctx.clients.get(key)
        if (caller.role === 'guest' || target === null || !caller.profileId || target.profileId !== caller.profileId) throw apiError('forbidden')
      }
      // Revoked NOW, before the answer: no new channel is accepted on its
      // connections from here on. Our own connection carries this answer, so it
      // closes once its open channels are done (or after the grace).
      if (!people.removeClient(key, { graceMs: key === who ? 3000 : 0 })) throw new HttpError(404, 'Dispositivo non trovato')
      return sendJson(req, res, 200, { ok: true })
    }
    if (n === 1 && a === 'profiles' && method === 'GET') {
      ownerOnly(caller)
      const transport = ctx.transport()
      const connected = new Set(transport ? transport.connectedClients() : [])
      const profiles = ctx.profiles.active().map((p) => {
        const keys = ctx.clients.boundTo(p.profileId)
        return {
          profileId: p.profileId,
          name: p.name,
          role: p.profileId === ctx.source.ownerProfileId ? 'owner' : 'member',
          devices: keys.length,
          connected: keys.filter((k) => connected.has(k)).length,
          createdAt: p.createdAt,
          lastSeenAt: p.lastSeenAt,
          recovery: ctx.recovery.hasAny(p.profileId)
        }
      })
      return sendJson(req, res, 200, { profiles })
    }
    if (n === 2 && a === 'profiles' && method === 'DELETE') {
      ownerOnly(caller)
      if (!isProfileId(b)) throw new HttpError(404, 'Profilo non trovato')
      people.removeProfile(b)
      return sendJson(req, res, 200, { ok: true })
    }
    if (n === 1 && a === 'claim' && method === 'POST') {
      if (!caller.local) throw apiError('forbidden')
      const body = await readJsonObject(req)
      const minutes = body.minutes === undefined || body.minutes === null ? 30 : body.minutes
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw new HttpError(400, 'Minuti non validi')
      return sendJson(req, res, 200, people.openClaim(minutes))
    }
    if (n === 1 && a === 'owner' && method === 'POST') {
      if (!caller.local) throw apiError('forbidden')
      const body = await readJsonObject(req)
      if (!isProfileId(body.profileId)) throw new HttpError(404, 'Profilo non trovato')
      // Answered once the data moved with it is merged.
      await people.setOwner(body.profileId, body.moveData === true)
      return sendJson(req, res, 200, { ok: true, ownerProfileId: body.profileId })
    }
    throw new HttpError(404, 'Risorsa non trovata')
  }
}

// The photo of PUT /api/profile/photo: null for none, the bytes when it is a valid
// JPEG in standard base64, undefined for anything else.
function photoBytes (value) {
  if (value === null) return null
  if (typeof value !== 'string' || !BASE64_RE.test(value)) return undefined
  const bytes = Buffer.from(value, 'base64')
  return validPhoto(bytes) ? bytes : undefined
}

// A version in the query of /api/library: a decimal safe integer, else null (not known).
function versionParam (query, name) {
  const v = query.get(name)
  if (v === null || !/^\d{1,16}$/.test(v)) return null
  const n = Number(v)
  return Number.isSafeInteger(n) ? n : null
}

// An epoch in the query of /api/library: 16 lowercase hex, else null (not known).
function epochParam (query, name) {
  const v = query.get(name)
  return v !== null && EPOCH_RE.test(v) ? v : null
}

// The cover entries of these ids as they are now: { small, large }, or null when cleared.
function movedCovers (ids, entries) {
  const out = {}
  for (const id of ids) {
    const e = entries.get(id)
    out[id] = e === undefined ? null : { small: e.small, large: e.large }
  }
  return out
}

// A whole number in the query: null when absent, undefined when it is not one.
function wholeParam (query, name) {
  if (!query.has(name)) return null
  const v = query.get(name)
  if (!/^\d{1,16}$/.test(v)) return undefined
  const n = Number(v)
  return Number.isSafeInteger(n) ? n : undefined
}

// The :filename segment, reduced to its last component (title fallback only).
function cleanFileName (name) {
  return cleanUploadName(name)
}

// A Range that does not start at byte 0 continues a playback already going (from
// byte 0 it may be a new one: jobs.pick decides).
function isContinuation (header) {
  if (typeof header !== 'string') return false
  const m = /^\s*bytes\s*=\s*(\d*)\s*-/i.exec(header)
  if (m === null) return false
  return m[1] === '' || Number(m[1]) > 0
}

async function statOrNull (file) {
  try {
    return await fs.promises.stat(file)
  } catch {
    return null
  }
}

// Serve a file with Range, If-Range and If-None-Match (headers already set). A
// satisfiable Range without If-Range always gets 206.
async function sendFile (req, res, file, size, tag, open = null) {
  if (etagMatches(req.headers['if-none-match'], tag)) {
    res.statusCode = 304
    res.end()
    return
  }

  let range = parseRange(req.headers.range, size)
  const ifRange = req.headers['if-range']
  if (range !== null && typeof ifRange === 'string' && ifRange.trim() !== tag) range = null

  if (range === UNSATISFIABLE) {
    res.removeHeader('Content-Type')
    res.removeHeader('Cache-Control')
    res.statusCode = 416
    res.setHeader('Content-Range', 'bytes */' + size)
    res.setHeader('Content-Length', 0)
    res.end()
    return
  }

  let start = 0
  let end = size - 1
  if (range !== null) {
    start = range.start
    end = range.end
    res.statusCode = 206
    res.setHeader('Content-Range', 'bytes ' + start + '-' + end + '/' + size)
  } else {
    res.statusCode = 200
  }
  res.setHeader('Content-Length', size === 0 ? 0 : end - start + 1)
  if (req.method === 'HEAD' || size === 0) {
    res.end()
    return
  }
  await pipeStreams(open !== null ? open(start, end) : fs.createReadStream(file, { start, end }), res).catch(() => {})
}
