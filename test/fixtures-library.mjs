// The answers of the library routes for scripted histories, as saved files.
//
// A history drives a whole source (createMPfy, in this process, on a temp data dir)
// through uploads, edits, deletes, transcodes made, lyrics flags, covers, likes,
// playlists, plays, a profile claim, an owner change with its data moved, restarts
// and a data dir from before profiles. Every answer of GET (and HEAD)
// /api/library, of the likes, playlists, played, recents and cover-for routes and
// of PATCH and DELETE /api/tracks is kept as one text file under
// test/fixtures/library-v3/<history>/. unit-library-fixtures.test.mjs plays every
// history again and compares each answer with its file, byte for byte.
//
// None of these requests sends `delta`, `he`, `uv` or `ue`: every later source
// must keep giving exactly these answers to them.
//
// What is masked, and how (the same rule on both sides of the comparison):
// - The clock. While a history runs, Date.now() is a step clock: CLOCK_BASE
//   (2026-01-01T00:00:00Z) plus one CLOCK_STEP (1 s) per request sent, per start
//   of the source and per explicit jump. So every time the source writes is
//   known, whatever the real time. In a saved body every number under a key
//   named `at`, `createdAt`, `updatedAt` or `addedAt` is written as the string
//   "@<seconds since CLOCK_BASE>" (a negative number for the times of the data
//   dir from before profiles, which are older).
// - Versions. In a 200 answer of /api/library the top-level `version` and
//   `userVersion` are written as "<version>" and "<userVersion>". A request that
//   sends `have` or If-None-Match takes the value of an earlier answer of the same
//   run, and its file says which one: `have=(version of 012)`, `(etag of 012)`.
//   No request sends a version or a tag across a restart (a source that keeps its
//   versions through a restart answers those differently, and rightly).
// - The ETag. `W/"<who>.<anything>"` is written `W/"<who>.*"`: the first part
//   (the caller's profile id, or `owner` for the owner acting without one) is
//   kept, the versions and anything after them are not.
// - Gzip. An answer sent gzipped is kept decompressed, with its
//   `content-encoding` header.
// - Byte for byte. A body is parsed, masked and written again with
//   JSON.stringify; before that, the bytes received must equal JSON.stringify of
//   their own parse (checked on every answer), so nothing but the masked values
//   can differ between two answers whose files are equal.
// Kept from the answer: the status, and the headers cache-control,
// content-encoding, content-type, etag and vary when present. Content-Length and
// Transfer-Encoding are not kept (a body may be sent either way).
//
// To write the files again (only ever on the code they were made from):
//   node test/fixtures-library.mjs write

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createMPfy } from '../server/app.mjs'
import { albumIdOf } from '../server/ids.mjs'
import {
  tmpDir, rmDir, request, makeWav, makeMp3, fakePng, fakeJpeg, fakeTool, fakeFfmpeg, makeProfile, proofHeaders, testWhoIs, hash24
} from './helpers.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
export const FIXTURES_DIR = path.join(here, 'fixtures', 'library-v3')
export const CLOCK_BASE = Date.UTC(2026, 0, 1)
export const CLOCK_STEP = 1000

const TIME_KEYS = new Set(['at', 'createdAt', 'updatedAt', 'addedAt'])
const KEPT_HEADERS = ['cache-control', 'content-encoding', 'content-type', 'etag', 'vary']
const DAY = 24 * 3600 * 1000

// ------------------------------------------------------------------ masking

/** A time as the saved files write it. */
export function maskTime (t) {
  return '@' + String((t - CLOCK_BASE) / 1000)
}

/** The ETag as the saved files write it. */
export function maskEtag (tag) {
  const m = /^W\/"([^."]+)\.[^"]*"$/.exec(tag)
  return m === null ? tag : 'W/"' + m[1] + '.*"'
}

function maskTimes (value) {
  if (Array.isArray(value)) return value.map(maskTimes)
  if (value === null || typeof value !== 'object') return value
  const out = {}
  for (const [k, v] of Object.entries(value)) out[k] = TIME_KEYS.has(k) && typeof v === 'number' ? maskTime(v) : maskTimes(v)
  return out
}

/** The saved form of a JSON body (see the top of this file). Throws on a body that is not canonical JSON. */
export function maskBody (text, { library = false } = {}) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('the answer is not JSON: ' + text.slice(0, 120))
  }
  if (JSON.stringify(parsed) !== text) throw new Error('the answer is not in the form JSON.stringify gives: ' + text.slice(0, 120))
  let out = maskTimes(parsed)
  if (library && out !== null && typeof out === 'object' && !Array.isArray(out)) {
    out = { ...out }
    if ('version' in out) out.version = '<version>'
    if ('userVersion' in out) out.userVersion = '<userVersion>'
  }
  return JSON.stringify(out)
}

// ------------------------------------------------------------------ clock

class StepClock {
  constructor () {
    this.t = CLOCK_BASE
    this._real = null
  }

  install () {
    this._real = Date.now
    Date.now = () => this.t
  }

  restore () {
    if (this._real !== null) Date.now = this._real
    this._real = null
  }

  tick (ms = CLOCK_STEP) {
    this.t += ms
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Until nothing runs in the background (media jobs, lyrics) and the shared
// version stopped moving.
async function settle (app) {
  let seen = null
  for (let i = 0; i < 500; i++) {
    await app.jobs.idle()
    await app.lyrics.idle()
    await sleep(8)
    const v = app.library.version
    if (v === seen) return
    seen = v
  }
  throw new Error('the source never settled')
}

// ------------------------------------------------------------------ data

const FOREIGN = 'f0'.repeat(12) // tracks of another source
const FOREIGN2 = 'e1'.repeat(12)
const P = { one: '0123456789abcdef', trip: '1111111111111111', gone: '2222222222222222', bacca: '3333333333333333', sara: '4444444444444444', old: '5555555555555555' }
const KEYS = { bacca: 'b1'.repeat(32), sara: '5a'.repeat(32), legacy: '1e'.repeat(32) }
const PROFILES = {
  bacca: makeProfile(Buffer.alloc(32, 11)),
  sara: makeProfile(Buffer.alloc(32, 22)),
  legacy: makeProfile(Buffer.alloc(32, 33))
}

const uslt = (text) => ['USLT', Buffer.concat([Buffer.from([0]), Buffer.from('ita', 'latin1'), Buffer.from([0]), Buffer.from(text, 'latin1')])]

function songs () {
  const t1 = makeMp3({ frames: 60, title: 'Lascio il molo', artist: 'Riva Nord', album: 'Acque basse', cover: fakePng(3) })
  const t2 = makeWav({ seconds: 2, freq: 330, tags: { title: 'Onda lunga', artist: 'Riva Nord', album: 'Acque basse' } })
  const t3 = makeMp3({ frames: 50, title: 'Fari spenti', artist: 'Le Boe', album: 'Notturno', kbps: 192, extraFrames: [uslt('Lascio il molo al buio\nE la luna resta qui')] })
  const t4 = makeMp3({ frames: 45, title: 'Ultima corsa', artist: 'Le Boe', album: 'Notturno', kbps: 160 })
  const t5 = makeWav({ seconds: 1, freq: 520, tags: { title: 'Sabbia', artist: 'Dune', album: 'Costa' } })
  const t6 = makeWav({ seconds: 1, freq: 610, tags: { title: 'Conchiglia', artist: 'Dune', album: 'Costa' } })
  return { t1, t2, t3, t4, t5, t6 }
}

// ------------------------------------------------------------------ a run

/**
 * One history being played: the source, its clock, the callers, and the
 * exchanges kept so far ({ name, text } each, in order).
 */
class Run {
  constructor (history) {
    this.history = history
    this.files = []
    this.marks = new Map() // mark -> { n, version, etag }
    this.clock = new StepClock()
    this.dir = null
    this.work = null
    this.app = null
    this.opts = {}
    this.ff = null
  }

  async start (opts = this.opts) {
    this.opts = opts
    this.clock.tick()
    const { tools = false, ...rest } = opts
    let ffmpeg = null
    let fpcalc = null
    if (tools) {
      if (this.ff === null) {
        this.ff = fakeFfmpeg(this.work, tools.ffmpeg || {})
        this.fp = fakeTool(this.work, 'fpcalc', {})
      }
      ffmpeg = this.ff.command
      fpcalc = this.fp.command
    }
    this.app = await createMPfy({
      dataDir: this.dir, port: 0, adminPort: 0, p2p: false, debounceMs: 10, name: 'Fonte di prova', ffmpeg, fpcalc, sevenZip: null, whoIs: testWhoIs, loudnessScan: false, ...rest
    })
    await this.app.jobsStarted
    await this.app.songsStarted
    await settle(this.app)
  }

  async restart () {
    await this.app.close()
    this.app = null
    await this.start()
  }

  /** A caller: 'local' (127.0.0.1, the owner without a profile) or a device of KEYS. */
  _headers (who, withProfile) {
    if (who === 'local') return {}
    const h = { 'x-test-client': KEYS[who] }
    if (withProfile) Object.assign(h, proofHeaders(PROFILES[who], KEYS[who], this.app.serverPublicKey))
    return h
  }

  admit (who) {
    this.app.clients.add(KEYS[who], 'Telefono di ' + who)
  }

  /**
   * Send a request as `who` and wait until the source settles. opts: body (an
   * object is sent as JSON), have / inm (a mark: the version / ETag of that
   * answer), gzip, profile (send the profile headers, default true), record (the
   * label: keep this exchange), mark (remember this answer's version and ETag),
   * status (the status expected, checked).
   */
  async send (who, method, urlPath, opts = {}) {
    const { body = null, have = null, inm = null, gzip = false, profile = true, record = null, mark = null, status = null } = opts
    this.clock.tick()
    const headers = this._headers(who, profile)
    let shownPath = urlPath
    let realPath = urlPath
    if (have !== null) {
      const m = this._mark(have)
      const sep = urlPath.includes('?') ? '&' : '?'
      realPath += sep + 'have=' + m.version
      shownPath += sep + 'have=(version of ' + m.n + ')'
    }
    const shownHeaders = []
    if (inm !== null) {
      const m = this._mark(inm)
      headers['if-none-match'] = m.etag
      shownHeaders.push('if-none-match: (etag of ' + m.n + ')')
    }
    if (gzip) {
      headers['accept-encoding'] = 'gzip'
      shownHeaders.push('accept-encoding: gzip')
    }
    const res = await request(this.app.ports.http, method, realPath, { headers, body, localAddress: who === 'local' ? undefined : '127.0.0.2' })
    if (status !== null && res.status !== status) {
      throw new Error(this.history + ': ' + method + ' ' + urlPath + ' answered ' + res.status + ' (expected ' + status + '): ' + res.body.toString('utf8').slice(0, 300))
    }
    await settle(this.app)
    let text = res.body
    if (res.headers['content-encoding'] === 'gzip' && text.length > 0) text = zlib.gunzipSync(text)
    text = text.toString('utf8')
    const isLibrary = urlPath === '/api/library' || urlPath.startsWith('/api/library?')
    if (mark !== null) {
      if (res.status !== 200 || method !== 'GET') throw new Error('only a 200 GET can be a mark')
      this.marks.set(mark, { n: null, version: JSON.parse(text).version, etag: res.headers.etag })
    }
    if (record === null) return res
    const n = String(this.files.length + 1).padStart(3, '0')
    if (mark !== null) this.marks.get(mark).n = n
    const lines = ['> ' + method + ' ' + shownPath, '> as: ' + who + (who !== 'local' && !profile ? ' (no profile headers)' : '')]
    for (const h of shownHeaders) lines.push('> ' + h)
    if (body !== null) lines.push('> body: ' + describeBody(body))
    lines.push('< ' + res.status)
    for (const h of KEPT_HEADERS) {
      const v = res.headers[h]
      if (v === undefined) continue
      lines.push('< ' + h + ': ' + (h === 'etag' ? maskEtag(v) : v))
    }
    const hasBody = text.length > 0
    if ((res.status === 304 || method === 'HEAD') && hasBody) throw new Error('a ' + res.status + ' ' + method + ' with a body')
    lines.push('')
    lines.push(hasBody ? maskBody(text, { library: isLibrary && res.status === 200 }) : '')
    this.files.push({ name: n + '-' + record + '.txt', text: lines.join('\n') + '\n' })
    return res
  }

  _mark (name) {
    const m = this.marks.get(name)
    if (m === undefined) throw new Error('no mark ' + name)
    if (m.n === null) throw new Error('mark ' + name + ' was not recorded')
    return m
  }

  /** Upload a file as `who`; its track id. Not kept: an upload answer shows jobs still running. */
  async upload (who, name, bytes) {
    const res = await this.send(who, 'PUT', '/api/upload/' + name, { body: bytes })
    if (res.status !== 200) throw new Error('upload ' + name + ' answered ' + res.status + ': ' + res.body.toString('utf8').slice(0, 300))
    return hash24(bytes)
  }

  /** A local admin call (the CLI's path while the source runs). */
  async admin (urlPath, body) {
    const res = await this.send('local', 'POST', urlPath, { body })
    if (res.status !== 200) throw new Error(urlPath + ' answered ' + res.status)
  }
}

function describeBody (body) {
  if (Buffer.isBuffer(body)) return '(' + body.length + ' bytes, sha256 ' + crypto.createHash('sha256').update(body).digest('hex').slice(0, 24) + ')'
  return JSON.stringify(maskTimes(body))
}

// --------------------------------------------------------------- histories

// The owner without profiles: uploads, the conditional answers, edits, a
// transcode made later, lyrics, shared covers, likes, playlists, playlist
// covers, plays, recents, a track deleted everywhere, a restart.
async function owner (r) {
  await r.start({ tools: { ffmpeg: { fail: '48k' } } })
  const s = songs()
  const g = (record, opts = {}) => r.send('local', 'GET', '/api/library', { record, status: opts.inm ? null : 200, ...opts })

  await g('library-empty', { mark: 'empty' })
  await g('library-same-etag', { inm: 'empty', status: 304 })
  await r.send('local', 'HEAD', '/api/library', { record: 'library-head', status: 200 })

  const t1 = await r.upload('local', 'molo.mp3', s.t1)
  const t2 = await r.upload('local', 'onda.wav', s.t2)
  const t3 = await r.upload('local', 'fari.mp3', s.t3)
  const t4 = await r.upload('local', 'corsa.mp3', s.t4)

  await g('library-after-uploads', { have: 'empty', mark: 'uploads' })
  await g('library-have-current', { have: 'uploads' })
  await g('library-same-etag-after-uploads', { inm: 'uploads', status: 304 })
  await g('library-gzip', { gzip: true })
  await g('library-have-and-old-etag', { have: 'uploads', inm: 'empty' })

  await r.send('local', 'PATCH', '/api/tracks/' + t2, { body: { title: 'Onda lunghissima', album: 'Acque alte' }, record: 'track-edit', status: 200 })
  await g('library-after-edit', { have: 'uploads', mark: 'edit' })

  // The low transcodes failed at upload; a stream asks for one now, past the
  // half hour a failed job waits.
  r.ff.control({})
  r.clock.tick(31 * 60 * 1000)
  const st = await r.send('local', 'GET', '/api/stream/' + t1 + '?q=low')
  if (st.status !== 200) throw new Error('stream answered ' + st.status)
  await g('library-after-transcode', { have: 'edit', mark: 'transcode' })

  await r.send('local', 'PUT', '/api/lyrics/' + t1, { body: '[00:01.00]Lascio il molo al buio\n[00:02.50]E il vento porta sale\n', status: 200 })
  await r.send('local', 'PUT', '/api/lyrics/' + t2, { body: 'Una riga inventata\nE poi un\'altra', status: 200 })
  await r.send('local', 'DELETE', '/api/lyrics/' + t3, { status: 200 })
  await g('library-after-lyrics', { have: 'transcode', mark: 'lyrics' })

  const album = albumIdOf({ album: 'Acque basse', albumArtist: 'Riva Nord' })
  await r.send('local', 'PUT', '/api/cover-for/track/' + t2 + '?size=large', { body: fakeJpeg(21, 3000), record: 'cover-track-put', status: 200 })
  await r.send('local', 'PUT', '/api/cover-for/album/' + album + '?size=small', { body: fakeJpeg(22, 2000), record: 'cover-album-put', status: 200 })
  await r.send('local', 'PUT', '/api/cover-for/track/' + FOREIGN + '?size=small', { body: fakeJpeg(23, 2000), record: 'cover-foreign-track-put', status: 200 })
  await r.send('local', 'DELETE', '/api/cover-for/track/' + t2, { record: 'cover-track-delete', status: 200 })
  await g('library-after-covers', { have: 'lyrics', mark: 'covers' })

  await r.send('local', 'PUT', '/api/likes/' + t1, { record: 'like-1', status: 200 })
  await r.send('local', 'PUT', '/api/likes/' + t3, { record: 'like-2', status: 200 })
  await r.send('local', 'PUT', '/api/likes/' + FOREIGN, { record: 'like-foreign', status: 200 })
  await r.send('local', 'PUT', '/api/likes/' + t4, { record: 'like-3', status: 200 })
  await r.send('local', 'PUT', '/api/likes/' + t1, { record: 'like-again', status: 200 })
  await r.send('local', 'DELETE', '/api/likes/' + t3, { record: 'unlike', status: 200 })
  await r.send('local', 'DELETE', '/api/likes/' + t3, { record: 'unlike-again', status: 200 })
  await r.send('local', 'PUT', '/api/likes/' + 'F0'.repeat(12), { record: 'like-bad-id', status: 400 })
  await g('library-after-likes', { have: 'covers', mark: 'likes' })
  await g('library-after-likes-old-etag', { inm: 'covers' })

  const pl = (method, p, record, body, status = 200) => r.send('local', method, p, { body, record, status })
  await pl('POST', '/api/playlists', 'playlist-create-default-name', { id: P.one })
  await pl('POST', '/api/playlists', 'playlist-create-named', { id: P.trip, name: '  Viaggio\u0007 ', description: 'In macchina' })
  await pl('POST', '/api/playlists', 'playlist-create-taken-id', { id: P.one }, 409)
  await pl('POST', '/api/playlists', 'playlist-create-bad-id', { id: 'nope' }, 400)
  await pl('POST', '/api/playlists/' + P.one + '/tracks', 'playlist-add', { trackIds: [t1, t2] })
  await pl('POST', '/api/playlists/' + P.one + '/tracks', 'playlist-add-at', { trackIds: [t3, FOREIGN], position: 1 })
  await pl('POST', '/api/playlists/' + P.one + '/tracks', 'playlist-add-past-end', { trackIds: [t1, t4], position: 99 })
  await pl('POST', '/api/playlists/' + P.one + '/tracks', 'playlist-add-empty', { trackIds: [] }, 400)
  await pl('POST', '/api/playlists/' + P.one + '/tracks', 'playlist-add-bad-position', { trackIds: [t1], position: -1 }, 400)
  // [t1, t3, FOREIGN, t2, t1, t4]
  await pl('DELETE', '/api/playlists/' + P.one + '/tracks', 'playlist-remove-index', { indexes: [2] })
  // [t1, t3, t2, t1, t4]: the client saw t1 at 0 and 3, and asks for the copy at 4 (moved): its nearest.
  await pl('DELETE', '/api/playlists/' + P.one + '/tracks', 'playlist-remove-checked', { indexes: [4], ids: [t1], counts: [2] })
  await pl('DELETE', '/api/playlists/' + P.one + '/tracks', 'playlist-remove-gone', { indexes: [0], ids: [FOREIGN] })
  await pl('DELETE', '/api/playlists/' + P.one + '/tracks', 'playlist-remove-out-of-range', { indexes: [40] }, 400)
  await pl('POST', '/api/playlists/' + P.one + '/tracks', 'playlist-add-again', { trackIds: [FOREIGN2], position: 0 })
  // Now [FOREIGN2, t1, t3, t2, t4]. A reorder made on [t1, t3, t2, t4] (before the add): rebased.
  await pl('PATCH', '/api/playlists/' + P.one, 'playlist-reorder-rebased', { trackIds: [t4, t2, t3, t1], base: [t1, t3, t2, t4] })
  await pl('PATCH', '/api/playlists/' + P.one, 'playlist-reorder-whole', { trackIds: [t1, t2, t3, t4, FOREIGN2] })
  await pl('PATCH', '/api/playlists/' + P.trip, 'playlist-rename', { name: 'Viaggio lungo' })
  await pl('PATCH', '/api/playlists/' + P.trip, 'playlist-describe-null', { description: null })
  await pl('PATCH', '/api/playlists/' + P.trip, 'playlist-rename-empty', { name: '   ' }, 400)
  await pl('PATCH', '/api/playlists/' + 'ffffffffffffffff', 'playlist-unknown', { name: 'X' }, 404)
  await pl('POST', '/api/playlists/' + P.trip + '/tracks', 'playlist-trip-add', { trackIds: [t2, t4, FOREIGN] })
  await pl('POST', '/api/playlists', 'playlist-create-to-delete', { id: P.gone, name: 'Da togliere' })
  await r.send('local', 'PUT', '/api/cover-for/playlist/' + P.gone + '?size=small', { body: fakeJpeg(31, 1500), record: 'cover-playlist-put-small', status: 200 })
  await r.send('local', 'PUT', '/api/cover-for/playlist/' + P.trip + '?size=small', { body: fakeJpeg(32, 1500), record: 'cover-playlist-put-small-2', status: 200 })
  await r.send('local', 'PUT', '/api/cover-for/playlist/' + P.trip + '?size=large', { body: fakeJpeg(33, 4000), record: 'cover-playlist-put-large', status: 200 })
  await r.send('local', 'PUT', '/api/cover-for/playlist/' + P.one + '?size=large', { body: fakeJpeg(34, 4000), record: 'cover-playlist-put-large-2', status: 200 })
  await r.send('local', 'DELETE', '/api/cover-for/playlist/' + P.one, { record: 'cover-playlist-delete', status: 200 })
  await g('library-after-playlists', { have: 'likes', mark: 'playlists' })
  await pl('DELETE', '/api/playlists/' + P.gone, 'playlist-delete')
  await pl('DELETE', '/api/playlists/' + P.gone, 'playlist-delete-again', undefined, 404)
  await g('library-after-playlist-delete', { have: 'playlists', mark: 'deleted' })

  const now = () => r.clock.t + CLOCK_STEP // the time of the next request
  const play = (record, body, status = 200) => r.send('local', 'POST', '/api/played', { body, record, status })
  await play('played', { trackId: t1, context: { type: 'playlist', id: P.one } })
  await play('played-no-context', { trackId: t2 })
  await play('played-offline', { trackId: FOREIGN, at: now() - 2 * 3600 * 1000, context: { type: 'liked' } })
  await play('played-offline-older', { trackId: t3, at: now() - 3 * 3600 * 1000, context: { type: 'album', id: album } })
  await play('played-too-old', { trackId: t4, at: now() - 40 * DAY })
  await play('played-future', { trackId: t2, at: now() + 3600 * 1000, context: { type: 'search' } })
  await play('played-bad-context', { trackId: t2, context: { type: 'radio' } }, 400)
  await play('played-bad-id', { trackId: 'x' }, 400)
  await g('library-after-plays', { have: 'deleted', mark: 'plays' })
  await r.send('local', 'GET', '/api/recents?limit=3', { record: 'recents-page', status: 200 })
  await r.send('local', 'GET', '/api/recents', { record: 'recents-all', status: 200 })

  await r.send('local', 'DELETE', '/api/tracks/' + t4, { record: 'track-delete', status: 200 })
  await g('library-after-track-delete', { have: 'plays', mark: 'trackdel' })

  await r.restart()
  await g('library-after-restart', { mark: 'restart' })
  await g('library-after-restart-same-etag', { inm: 'restart', status: 304 })
  await g('library-after-restart-have-current', { have: 'restart' })
  await r.send('local', 'PUT', '/api/likes/' + t2, { record: 'like-after-restart', status: 200 })
  await play('played-after-restart', { trackId: t3, context: { type: 'artist', id: 'le-boe' } })
  await g('library-after-restart-changes', { have: 'restart' })
  await g('library-after-restart-changes-gzip', { have: 'restart', gzip: true })
}

// People: the owner's data from before the claim, the claim, a member, the
// owner acting without a profile, a member's track deleted, a restart, and the
// owner changed with the data moved (a merge).
async function people (r) {
  await r.start({})
  const s = songs()
  const t5 = await r.upload('local', 'sabbia.wav', s.t5)
  await r.send('local', 'POST', '/api/playlists', { body: { id: P.bacca, name: 'Spiaggia' }, record: 'playlist-create-before-claim', status: 200 })
  await r.send('local', 'POST', '/api/playlists/' + P.bacca + '/tracks', { body: { trackIds: [t5, FOREIGN] }, record: 'playlist-add-before-claim', status: 200 })
  await r.send('local', 'PUT', '/api/likes/' + t5, { record: 'like-before-claim', status: 200 })
  await r.send('local', 'POST', '/api/played', { body: { trackId: t5 }, record: 'played-before-claim', status: 200 })
  await r.send('local', 'GET', '/api/library', { record: 'library-before-claim', status: 200 })

  await r.admin('/api/admin/claim', { minutes: 30 })
  r.admit('bacca')
  r.admit('sara')
  const pr = await r.send('bacca', 'GET', '/api/profile', { status: 200 })
  if (JSON.parse(pr.body).role !== 'owner') throw new Error('the claim did not happen')
  await r.send('bacca', 'GET', '/api/library', { record: 'library-owner-profile', status: 200, mark: 'bacca' })
  await r.send('local', 'GET', '/api/library', { record: 'library-owner-local', status: 200, mark: 'local' })
  await r.send('local', 'GET', '/api/library', { record: 'library-owner-local-same-etag', inm: 'local' })
  await r.send('local', 'GET', '/api/library', { record: 'library-owner-local-with-profile-etag', inm: 'bacca' })
  await r.send('sara', 'GET', '/api/library', { record: 'library-member-first', status: 200, mark: 'sara' })
  await r.send('sara', 'GET', '/api/library', { record: 'library-member-same-etag', inm: 'sara', status: 304 })

  const t6 = await r.upload('sara', 'conchiglia.wav', s.t6)
  await r.send('sara', 'GET', '/api/library', { record: 'library-member-after-upload', have: 'sara', status: 200, mark: 'sara2' })
  await r.send('bacca', 'GET', '/api/library', { record: 'library-owner-after-member-upload', have: 'bacca', status: 200, mark: 'bacca2' })
  await r.send('sara', 'POST', '/api/playlists', { body: { id: P.bacca }, record: 'member-playlist-id-of-owner', status: 409 })
  await r.send('sara', 'POST', '/api/playlists', { body: { id: P.sara, name: 'Di Sara' }, record: 'member-playlist-create', status: 200 })
  await r.send('sara', 'POST', '/api/playlists/' + P.sara + '/tracks', { body: { trackIds: [t5, t6, t6] }, record: 'member-playlist-add', status: 200 })
  await r.send('sara', 'PATCH', '/api/playlists/' + P.bacca, { body: { name: 'Mia' }, record: 'member-playlist-of-owner', status: 404 })
  await r.send('sara', 'PUT', '/api/likes/' + t6, { record: 'member-like', status: 200 })
  await r.send('sara', 'PUT', '/api/likes/' + t5, { record: 'member-like-2', status: 200 })
  await r.send('sara', 'POST', '/api/played', { body: { trackId: t6, context: { type: 'playlist', id: P.sara } }, record: 'member-played', status: 200 })
  await r.send('sara', 'PUT', '/api/cover-for/playlist/' + P.sara + '?size=small', { body: fakeJpeg(41, 1500), record: 'member-cover-playlist', status: 200 })
  await r.send('sara', 'PUT', '/api/cover-for/track/' + t5 + '?size=small', { body: fakeJpeg(42, 1500), record: 'member-cover-track-not-hers', status: 403 })
  await r.send('sara', 'PATCH', '/api/tracks/' + t5, { body: { title: 'Mia' }, record: 'member-edit-not-hers', status: 403 })
  await r.send('sara', 'PATCH', '/api/tracks/' + t6, { body: { artist: 'Dune e Mare' }, record: 'member-edit-hers', status: 200 })
  await r.send('bacca', 'PUT', '/api/likes/' + t6, { record: 'owner-like-member-track', status: 200 })
  await r.send('bacca', 'GET', '/api/library', { record: 'library-owner-after-member-changes', have: 'bacca2', status: 200 })
  await r.send('sara', 'GET', '/api/library', { record: 'library-member-after-changes', have: 'sara2', status: 200, mark: 'sara3' })

  await r.send('sara', 'DELETE', '/api/tracks/' + t6, { record: 'member-track-delete', status: 200 })
  await r.send('sara', 'GET', '/api/library', { record: 'library-member-after-track-delete', have: 'sara3', status: 200 })
  await r.send('bacca', 'GET', '/api/library', { record: 'library-owner-after-member-track-delete', status: 200 })
  await r.send('bacca', 'DELETE', '/api/likes/' + t5, { record: 'owner-unlike', status: 200 })

  await r.restart()
  await r.send('bacca', 'GET', '/api/library', { record: 'library-owner-after-restart', status: 200 })
  await r.send('sara', 'GET', '/api/library', { record: 'library-member-after-restart', status: 200 })
  await r.send('local', 'GET', '/api/library', { record: 'library-local-after-restart', status: 200 })

  // set-owner --move-data: Sara becomes the owner and gets Bacca's data.
  await r.admin('/api/admin/owner', { profileId: PROFILES.sara.id, moveData: true })
  await r.send('sara', 'GET', '/api/library', { record: 'library-new-owner-merged', status: 200 })
  await r.send('bacca', 'GET', '/api/library', { record: 'library-old-owner-moved', status: 200 })
  await r.send('local', 'GET', '/api/library', { record: 'library-local-new-owner', status: 200 })
  await r.restart()
  await r.send('sara', 'GET', '/api/library', { record: 'library-new-owner-after-restart', status: 200 })
}

// A data dir from before profiles (db.json schema 2 with the owner's data in
// it, a device admitted then): the first start moves the data; the old device
// acts as the owner, then claims the source with its new profile.
async function olderDir (r) {
  const dir = r.dir
  const wav = makeWav({ seconds: 1, freq: 440, tags: { title: 'Scogli', artist: 'Mare', album: 'Costa' } })
  const id = hash24(wav)
  const img = { pl: fakeJpeg(51, 900), album: fakeJpeg(52, 900), track: fakeJpeg(53, 900) }
  fs.mkdirSync(path.join(dir, 'library'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'covers'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'library', id + '.wav'), wav)
  for (const b of Object.values(img)) fs.writeFileSync(path.join(dir, 'covers', hash24(b) + '.jpg'), b)
  fs.writeFileSync(path.join(dir, 'clients.json'), JSON.stringify([{ publicKey: KEYS.legacy, name: 'Telefono di prima', addedAt: CLOCK_BASE - 9 * DAY }]))
  const old = (d) => CLOCK_BASE - d * DAY
  const album = albumIdOf({ album: 'Costa', albumArtist: 'Mare' })
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({
    schema: 2,
    version: 42,
    tracks: [{ id, title: 'Scogli', artist: 'Mare', album: 'Costa', albumArtist: 'Mare', trackNo: null, discNo: null, year: null, duration: 1, format: 'wav', mime: 'audio/wav', size: wav.length, bitrate: 128000, lossless: true, addedAt: old(8), coverId: null }],
    playlists: [
      { id: P.old, name: 'In auto', description: 'Le solite', trackIds: [id, FOREIGN, id], createdAt: old(7), updatedAt: old(6) },
      { id: P.one, name: 'Vuota', description: '', trackIds: [], createdAt: old(5), updatedAt: old(5), color: 'blu' }
    ],
    likes: [{ id: FOREIGN, at: old(4) }, { id, at: old(5) }],
    recents: [{ trackId: id, at: old(2), context: { type: 'playlist', id: P.old } }, { trackId: FOREIGN2, at: old(3), context: { type: 'library' } }],
    covers: {
      track: { [id]: { small: null, large: hash24(img.track) } },
      album: { [album]: { small: hash24(img.album), large: null } },
      playlist: { [P.old]: { small: hash24(img.pl), large: hash24(img.pl) } }
    }
  }))
  await r.start({})
  await r.send('local', 'GET', '/api/library', { record: 'library-migrated-local', status: 200, mark: 'local' })
  await r.send('legacy', 'GET', '/api/library', { record: 'library-migrated-old-device', status: 200, profile: false, mark: 'legacy' })
  await r.send('legacy', 'GET', '/api/library', { record: 'library-old-device-same-etag', profile: false, inm: 'legacy', status: 304 })
  await r.send('legacy', 'PUT', '/api/likes/' + FOREIGN2, { record: 'old-device-like', status: 200, profile: false })
  await r.send('legacy', 'DELETE', '/api/playlists/' + P.one + '/tracks', { body: { indexes: [0] }, record: 'old-device-remove-from-empty', status: 400, profile: false })
  await r.send('legacy', 'POST', '/api/playlists/' + P.old + '/tracks', { body: { trackIds: [FOREIGN2] }, record: 'old-device-playlist-add', status: 200, profile: false })
  await r.send('local', 'GET', '/api/library', { record: 'library-after-old-device-changes', have: 'local', status: 200 })
  // The same device, now with a profile: it is bound, and as the device of the
  // owner from before it claims the source.
  await r.send('legacy', 'GET', '/api/library', { record: 'library-old-device-claims', status: 200 })
  await r.send('local', 'GET', '/api/library', { record: 'library-local-after-claim', status: 200 })
  await r.send('legacy', 'PUT', '/api/likes/' + id, { record: 'claimed-like-again', status: 200 })
  await r.restart()
  await r.send('legacy', 'GET', '/api/library', { record: 'library-claimed-after-restart', status: 200 })
  await r.send('legacy', 'GET', '/api/library', { record: 'library-claimed-after-restart-gzip', status: 200, gzip: true })
}

export const HISTORIES = { owner, people, 'older-dir': olderDir }

/**
 * Play one history on today's code path; resolves its exchanges
 * ([{ name, text }] in order). The temp data dir is removed after.
 */
export async function runHistory (name) {
  const fn = HISTORIES[name]
  if (!fn) throw new Error('no history ' + name)
  const r = new Run(name)
  r.dir = tmpDir('mpfy-fixture-')
  r.work = tmpDir('mpfy-fixture-tools-')
  r.clock.install()
  try {
    await fn(r)
  } finally {
    if (r.app !== null) await r.app.close().catch(() => {})
    r.clock.restore()
    rmDir(r.dir)
    rmDir(r.work)
  }
  return r.files
}

/** The saved files of a history ([{ name, text }] sorted by name). */
export function savedFiles (name) {
  const dir = path.join(FIXTURES_DIR, name)
  return fs.readdirSync(dir).filter((f) => f.endsWith('.txt')).sort().map((f) => ({ name: f, text: fs.readFileSync(path.join(dir, f), 'utf8') }))
}

/** Where two texts first differ, with a little of each around it. */
export function firstDifference (expected, actual) {
  let i = 0
  while (i < expected.length && i < actual.length && expected[i] === actual[i]) i++
  if (i === expected.length && i === actual.length) return null
  const from = Math.max(0, i - 160)
  return 'at character ' + i + '\n  saved:  ...' + JSON.stringify(expected.slice(from, i + 160)) + '\n  answer: ...' + JSON.stringify(actual.slice(from, i + 160))
}

async function writeAll () {
  for (const name of Object.keys(HISTORIES)) {
    const files = await runHistory(name)
    const dir = path.join(FIXTURES_DIR, name)
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    for (const f of files) fs.writeFileSync(path.join(dir, f.name), f.text)
    process.stdout.write(name + ': ' + files.length + ' answers\n')
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== 'write') {
    process.stdout.write('usage: node test/fixtures-library.mjs write\n')
    process.exit(1)
  }
  writeAll().catch((err) => {
    process.stderr.write((err && err.stack) || String(err))
    process.stderr.write('\n')
    process.exit(1)
  })
}
