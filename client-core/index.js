// MPfy client core: the local core of the app. The same file runs inside the
// Android worklet (Bare) and on the PC (client-node, Node).
//
//   createClientCore({ statePath, webRoot, port = 47123, deviceName, onEvent })
//     -> { start(), stop(), state(), refresh() }
//
// - The state file (state.js) holds the client seed, the person's profile, the
//   recovery key and the paired sources. The profile photo's bytes are a file
//   next to it (photo.js).
// - One MPfyLink per source (transport/client.js), started at start() and kept up
//   with its own reconnect backoff, all on one shared HyperDHT node. Every request
//   to a source carries the profile headers (identity.js) once a profile exists.
// - Each source is synced (whether it has profiles, its role, its name, the
//   profile name and photo, the social settings and the profile card, the
//   recovery blob) when its link comes up, every 5 minutes, on POST /local/sync
//   and after every change of the identity, of the photo or of the settings.
// - The people (people.js): the union of what every social source lists, read
//   when the page asks (no timer of its own), each card checked here.
// - The chats (chat.js): conversations written to every source that holds them
//   and read as one union, end to end; read when the page (or the Android
//   notifier) asks, a source's list held open by it while they keep asking.
// - A local HTTP server on 127.0.0.1:<port> with its own request-head parser
//   (http.js; there is no 'http' module on Bare):
//     /local/sources            GET, POST { code }            list, pair and add
//     /local/sources/<id>       GET, PATCH { principal }, DELETE
//     /local/profile            GET, POST { name }, PATCH { name }
//     /local/profile/code       GET
//     /local/profile/photo      GET, PUT <JPEG bytes>, DELETE the profile photo
//     /local/profile/export     GET
//     /local/profile/import     POST { identity } or { code }
//     /local/profile/recovery   PUT { password }, DELETE
//     /local/recovery           POST { code }                 a temporary device
//     /local/recovery/<session> POST { profileId, device, password }, DELETE
//     /local/sync               POST
//     /local/people             GET                           the union of the people
//     /local/people/<id>        GET                           a person's page
//     /local/people/<id>/photo  GET                           a person's photo
//     /local/social             GET, PATCH { invisible?, showNow?, privateSession?, showRecent? }
//     /local/activity           PUT { track, playing }        what is playing, to every social source
//     /local/social/blocked     POST { profileId }            block someone
//     /local/social/blocked/<id> DELETE                       unblock them
//     /local/chat/conversations GET                           the union of the conversations
//     /local/chat/shared        GET                           the newest cards from others
//     /local/chat/<cid>/messages GET ?limit&before, POST { id?, text?, card?, replyTo? }
//     /local/chat/<cid>/messages/<id> DELETE                  for everyone (own messages)
//     /local/chat/<cid>/messages/<id>/playlist GET            the playlist a card shares
//     /local/chat/<cid>/read    PUT { id }
//     /local/chat/<cid>/mute    PUT { mute: 8h | 1w | always | off }
//     /local/phone/shadowed     PUT { all } | { add, remove }  the phone's songs a real source holds
//     /local/phone/moved        POST { to, uv, ue }           the person's data moved to the principal
//     /s/0000/<rest>            "Locale", the phone's own music, answered here (phone.js)
//     /s/<id>/<rest>            forwarded raw to that source as /<rest>
//     /__native/*               404 (the app serves those inside its WebView)
//     anything else             the UI's static files (static.js), SPA fallback
//   Every connection carries one request and is closed after its response. The
//   one origin is http://127.0.0.1:<port>: a request that names the core as
//   localhost or [::1] is redirected there.
// - onEvent, for the host only (never the page):
//     { type: 'sources', sources, home }   the list changed, a link went up or
//       down, or the home of the person's data moved (`home`, on a host with phone
//       music only: the real principal's id, "0000" while the phone store is the home)
//     { type: 'profile', profile }   the profile changed (its photo too)
//     { type: 'identity', fileName, identity }   at start and after every change
//       of the identity, for the identity file
//
// Portable: '#net', '#fs', '#path' import maps, b4a, sodium-native and the
// transport. No Node globals (process, Buffer, URL).

import net from '#net'
import b4a from 'b4a'
import { MPfyLink, pair, createDht, keyPairFromSeed, parseCode } from '../transport/client.js'
import {
  HttpError, findHeadEnd, parseRequestHead, ChunkedDecoder, buildForwardHead, splitSourceTarget,
  responseHead, etagMatches, MAX_HEAD_BYTES
} from './http.js'
import {
  readStateFile, writeStateFile, cloneState, cleanName, fixPrincipal, sourceIdOf, ensureParentDir,
  normalizeSources, roleOf, defaultSocial
} from './state.js'
import {
  profileKeys, proofHeaders, newProfileSecret, formatProfileCode, parseProfileCode, codeKind,
  cleanProfileName, identityFileName, buildIdentity, identityText, parseIdentity, passwordLongEnough,
  deriveRecoveryKeys, encryptBlob, decryptBlob, randomBytes, profileIdText, OPSLIMIT, MEMLIMIT
} from './identity.js'
import {
  makeCard, checkCard, directId, groupId, nameTags, byName, unitePeople, uniteRecent, sha256Hex, PhotoCache
} from './people.js'
import { sealMutes, openMutes } from './seal.js'
import { Chats, makeAccess, LIST_FRESH_MS, HOLD_SECONDS, GROUP_FRESH_MS } from './chat.js'
import { validPhoto, photoHash, isPhotoHash, photoWins, writePhoto, readPhoto, removePhoto, sweepPhotos } from './photo.js'
import { StaticFiles, mimeType, etagOf, MAX_STATIC_BYTES } from './static.js'
import { ThroughputMeter } from './meter.js'
import { pipeForward } from './forward.js'
import { PhoneSource, PHONE_ID, MAX_SHADOWED } from './phone.js'
import { PhonePerson } from './phone-person.js'

export { HttpError } from './http.js'

export const DEFAULT_PORT = 47123
// frame-ancestors (and X-Frame-Options for older browsers): no other site may show
// the UI in a frame of its own, where a click on its page would be a click here.
export const CSP = "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'"
// A request for a source whose link is down waits this long for it.
export const OFFLINE_WAIT_MS = 6000
// DELETE /local/sources/<id> first asks the source to forget this device.
export const REVOKE_TIMEOUT_MS = 2000
export const PAIR_TIMEOUT_MS = 45000
// Each request of a sync, and POST /local/sync as a whole.
export const SYNC_TIMEOUT_MS = 10000
export const SYNC_EVERY_MS = 5 * 60 * 1000
// POST /local/sources waits this long for the first sync of the source it adds.
export const FIRST_SYNC_WAIT_MS = 5000
export const RECOVERY_SESSION_MS = 10 * 60 * 1000
// A request of the recovery flow, the link's first connection included.
export const RECOVERY_REQUEST_MS = 15000
// How far ahead a time from a source may be and still be taken.
const SOURCE_FUTURE_MS = 5 * 60 * 1000
// The people: a source's list is read again when older than this, each request
// waits this long at most, and the page is answered after this wait at most
// (from what has come by then).
export const PEOPLE_FRESH_MS = 25000
const PEOPLE_TIMEOUT_MS = 8000
const PEOPLE_WAIT_MS = 3000
// A person's page waits this long for the pages of the sources.
const PAGE_WAIT_MS = 5000
// At least this long between two activity reports to one source (10 a minute at
// most: a burst of skips stays under the sources' 12).
export const ACTIVITY_GAP_MS = 6000
export const PRIVATE_SESSION_MS = 6 * 3600 * 1000
const IMMUTABLE = 'private, max-age=31536000, immutable'
const SECTIONS = ['privacy', 'blocked', 'mutes']
const PRIVACY_SWITCHES = ['invisible', 'showNow', 'privateSession', 'showRecent']
const ACTIVITY_KEYS = ['track', 'playing']
const TRACK_KEYS = ['trackId', 'title', 'artist', 'album', 'artistPage']
const MAX_TRACK_TEXT = 200
const BAD_CARDS_KEPT = 1000
const HEAD_TIMEOUT_MS = 30000
const BODY_TIMEOUT_MS = 30000
const MAX_LOCAL_BODY = 64 * 1024
// After its response, a connection is kept a moment so the client reads the
// answer (whatever it still sends is read and dropped), then closed for good.
const LINGER_MS = 5000
const LINGER_MAX_MS = 60000
const MAX_CONNECTIONS = 512
const DEFAULT_DEVICE_NAME = 'Dispositivo'

const HEX24_RE = /^[0-9a-f]{24}$/
const HEX32_RE = /^[0-9a-f]{32}$/
const HEX64_RE = /^[0-9a-f]{64}$/

// Errors of the /local endpoints: { error, code }. The page maps the code to its
// own words and never reads the text.
const LOCAL_ERRORS = {
  bad_request: [400, 'Richiesta non valida'],
  bad_name: [400, 'Nome non valido'],
  bad_file: [400, 'File non valido'],
  bad_code: [400, 'Codice non valido'],
  bad_photo: [400, 'Foto non valida'],
  source_code: [400, 'Questo \u00e8 il codice di una fonte'],
  profile_code: [400, 'Questo \u00e8 il codice del profilo'],
  short_password: [400, 'Almeno 8 caratteri'],
  refused: [403, 'Abbinamento rifiutato'],
  wrong_password: [403, 'Password errata'],
  no_profile: [404, 'Nessun profilo'],
  no_photo: [404, 'Nessuna foto'],
  no_recovery: [404, 'Recupero non attivo'],
  session_gone: [404, 'Sessione scaduta'],
  profile_exists: [409, 'Profilo gi\u00e0 presente'],
  locked: [429, 'Troppi tentativi'],
  failed: [500, 'Qualcosa non ha funzionato'],
  unreachable: [504, 'Fonte non raggiungibile'],
  changed: [409, 'I dati sono cambiati nel frattempo']
}
// The code of a /local error raised without one.
const STATUS_CODES = {
  400: 'bad_request',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  408: 'timeout',
  409: 'conflict',
  413: 'too_large',
  500: 'failed',
  503: 'unavailable',
  504: 'unreachable'
}

function localError (code, extra = null) {
  const [status, text] = LOCAL_ERRORS[code]
  return new HttpError(status, text, code, extra)
}

const EMPTY = b4a.alloc(0)
// Controls and line breaks in a track's text become spaces (built from code
// points so this file stays plain ASCII).
const LINE_BREAKS_RE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f' + String.fromCharCode(0x2028, 0x2029) + ']', 'g')
const noop = () => {}

/**
 * @param {object} opts
 * @param {string} opts.statePath   the state file (created when missing)
 * @param {string} opts.webRoot     the UI's static files
 * @param {number} [opts.port=47123]  0 picks a free port (tests)
 * @param {string} [opts.deviceName]  sent to a source when pairing ("PC", the phone model)
 * @param {(event: object) => void} [opts.onEvent]
 * @param {string} [opts.token]  the Android app's secret: /local/* and /s/* then need it,
 *   as the cookie mpfy_token or the X-MPfy-Token header. On a PC there is none (the
 *   state file is readable by the same user anyway)
 * Extras for tests and diagnostics:
 * @param {Array} [opts.bootstrap]  HyperDHT bootstrap nodes (default: the public DHT)
 * @param {object} [opts.dht]  a HyperDHT node to use (not destroyed by stop())
 * @param {(line: string) => void} [opts.log]
 * @param {number} [opts.offlineWaitMs=6000]
 * @param {number} [opts.headTimeoutMs=30000]
 * @param {number} [opts.pairTimeoutMs=45000]
 * @param {number} [opts.revokeTimeoutMs=2000]
 * @param {number} [opts.syncEveryMs=300000]
 * @param {number} [opts.firstSyncWaitMs=5000]
 * @param {number} [opts.recoverySessionMs=600000]
 * @param {number} [opts.recoveryRequestMs=15000]
 * @param {number} [opts.peopleFreshMs=25000]
 * @param {number} [opts.activityGapMs=6000]
 * @param {number} [opts.chatFreshMs=8000]  a source's list of conversations is read again when older
 * @param {number} [opts.chatHoldSeconds=25]  how long a source may hold that list for a change
 * @param {number} [opts.chatGroupFreshMs=60000]  a group's people are read again when older
 * @param {object} [opts.phone]  the phone's own music ("Locale", phone.js), on a host that has it:
 *   { dir, artDir, appVersion, send }: dir <statePath>.phone, artDir the host's covers (read
 *   only), send(msg) to the host (appVersion is the host's: its requests carry it); extras
 *   for tests: fs, now, lookups
 */
export function createClientCore (opts = {}) {
  const core = new ClientCore(opts)
  return {
    /** Load the state, start the links and the local server. Resolves { host, port }. */
    start: () => core.start(),
    /** Close everything (links, connections, the DHT node it made). */
    stop: () => core.stop(),
    /** A snapshot: { running, port, publicKey, profileId, connections, sources }. */
    state: () => core.state(),
    /** Call on a network change (Wi-Fi <-> mobile): every link re-checks itself. */
    refresh: () => core.refresh(),
    /** A { t: 'local' | 'net-reply', ... } from the host, for the phone's own music. */
    phoneMessage: (msg) => core.phoneMessage(msg)
  }
}

class ClientCore {
  constructor ({
    statePath, webRoot, port = DEFAULT_PORT, deviceName = DEFAULT_DEVICE_NAME, onEvent = null, token = null,
    bootstrap, dht = null, log = null, offlineWaitMs = OFFLINE_WAIT_MS, headTimeoutMs = HEAD_TIMEOUT_MS,
    pairTimeoutMs = PAIR_TIMEOUT_MS, revokeTimeoutMs = REVOKE_TIMEOUT_MS, syncEveryMs = SYNC_EVERY_MS,
    firstSyncWaitMs = FIRST_SYNC_WAIT_MS, recoverySessionMs = RECOVERY_SESSION_MS, recoveryRequestMs = RECOVERY_REQUEST_MS,
    peopleFreshMs = PEOPLE_FRESH_MS, activityGapMs = ACTIVITY_GAP_MS, chatFreshMs = LIST_FRESH_MS, chatHoldSeconds = HOLD_SECONDS,
    chatGroupFreshMs = GROUP_FRESH_MS, phone = null
  } = {}) {
    if (typeof statePath !== 'string' || statePath === '') throw new TypeError('statePath is required')
    if (typeof webRoot !== 'string' || webRoot === '') throw new TypeError('webRoot is required')
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('invalid port: ' + port)
    this._statePath = statePath
    this._webRoot = webRoot
    this._port = port
    this._deviceName = typeof deviceName === 'string' && deviceName.trim() !== '' ? deviceName.trim() : DEFAULT_DEVICE_NAME
    this._onEvent = typeof onEvent === 'function' ? onEvent : null
    if (token !== null && token !== undefined && (typeof token !== 'string' || token.length < 32)) throw new TypeError('invalid token')
    this._token = typeof token === 'string' ? b4a.from(token, 'latin1') : null
    this._bootstrap = bootstrap
    this._extDht = dht
    this._log = typeof log === 'function' ? log : noop
    this._offlineWaitMs = offlineWaitMs
    this._headTimeoutMs = headTimeoutMs
    this._pairTimeoutMs = pairTimeoutMs
    this._revokeTimeoutMs = revokeTimeoutMs
    this._syncEveryMs = syncEveryMs
    this._firstSyncWaitMs = firstSyncWaitMs
    this._recoverySessionMs = recoverySessionMs
    this._recoveryRequestMs = recoveryRequestMs
    this._peopleFreshMs = peopleFreshMs
    this._activityGapMs = activityGapMs
    this._chatFreshMs = chatFreshMs
    this._chatHoldSeconds = chatHoldSeconds
    this._chatGroupFreshMs = chatGroupFreshMs
    this._chats = null // chat.js, made at start
    this._phoneOpts = phone !== null && typeof phone === 'object' && typeof phone.dir === 'string' && phone.dir !== '' ? phone : null
    this._phone = null // phone.js, made at start
    this._phonePerson = null // phone-person.js: the person's data while it lives on the phone
    this._homeSaid = undefined // the home the last sources event carried

    this._state = null
    this._keyPair = null
    this._profileKeys = null // the keys of the current profile, made once
    this._cardMade = null // this profile's card as it is now, made once per change
    this._photos = new PhotoCache() // other people's photos, by hash
    this._photoFetches = new Map() // hash -> the fetch of that photo under way
    this._badCards = new Set() // source|profileId of a card already said not to verify
    this._static = null
    this._dht = null
    this._server = null
    this._boundPort = null
    this._origin = null
    this._sockets = new Set()
    this._sources = new Map() // id -> runtime (see _addRuntime)
    // Removals of a source, by id: the sequence number of the last time one
    // started or ended (see _addSource).
    this._removalSeq = 0
    this._removalSeen = new Map()
    this._sessions = new Map() // recovery sessions by id
    this._chain = Promise.resolve() // state writes, one at a time
    this._identityChain = Promise.resolve() // profile creation, imports, recovery: one at a time
    this._photoChain = Promise.resolve() // changes of the photo and its files: one at a time
    this._startPromise = null
    this._stopPromise = null
    this._running = false
    this._stopping = false
    this._onNetworkChange = () => {
      for (const rt of this._sources.values()) rt.meter.reset()
    }
  }

  // ------------------------------------------------------------ lifecycle

  start () {
    if (this._stopPromise !== null) return Promise.reject(new Error('core stopped'))
    if (this._startPromise === null) this._startPromise = this._start()
    return this._startPromise
  }

  async _start () {
    ensureParentDir(this._statePath)
    const { state, changed, setAside } = readStateFile(this._statePath)
    if (setAside !== null) this._log('state file unreadable, set aside as ' + setAside + '; starting with a new identity')
    // A photo whose file is gone (or no longer holds it) is none, at time 0: any
    // source that has it gives it back, and it never goes out as a removal. A file
    // that cannot be read just now (held by an antivirus on Windows) is not gone:
    // the photo stays, and so does its file.
    const p = state.profile
    let lost = false
    if (p !== null && p.photo !== null) {
      try {
        lost = readPhoto(this._statePath, p.photo) === null
      } catch (err) {
        this._log('profile photo file not readable now (' + ((err && (err.code || err.message)) || err) + '), kept as it is')
      }
    }
    if (lost) {
      this._log('profile photo file missing, the photo is taken again from the sources')
      p.photo = null
      p.photoUpdatedAt = 0
    }
    if (changed || lost) await writeStateFile(this._statePath, state)
    // Photo files the state does not point to: an older photo, one written for a
    // change that never landed, those of a state set aside.
    sweepPhotos(this._statePath, p !== null ? p.photo : null)
    this._state = state
    this._keyPair = keyPairFromSeed(state.clientSeed)
    this._static = new StaticFiles(this._webRoot)
    this._chats = new Chats(this, { outboxPath: this._statePath + '.chat-outbox.json', listFreshMs: this._chatFreshMs, holdSeconds: this._chatHoldSeconds, groupFreshMs: this._chatGroupFreshMs })
    if (this._phoneOpts !== null) this._startPhone()

    this._dht = this._extDht || createDht(this._bootstrap ? { bootstrap: this._bootstrap } : {})
    this._dht.on('network-change', this._onNetworkChange)
    for (const entry of state.sources) this._addRuntime(entry)
    try {
      await this._listen()
    } catch (err) {
      await this._teardown()
      throw err
    }
    this._running = true
    this._log('listening on ' + this._origin + ', ' + state.sources.length + ' source(s)' + (state.profile !== null ? ', profile ' + state.profile.id : ''))
    this._emitSources()
    this._emitIdentity()
    // Where the phone's feed stands, for the host, once it knows the core started.
    if (this._phone !== null) setTimeout(() => { if (this._phone !== null && !this._stopping) this._phone.hello() }, 0)
    return { host: '127.0.0.1', port: this._boundPort }
  }

  // ------------------------------------------------------------ the phone

  // "Locale" (phone.js): the phone's own music, a source the core serves itself; and
  // the person's data while no real source holds it (phone-person.js), at its address.
  _startPhone () {
    const o = this._phoneOpts
    const person = new PhonePerson({
      dir: o.dir,
      fs: o.fs,
      now: o.now,
      epochId: o.epochId,
      host: {
        profileId: () => (this._state !== null && this._state.profile !== null ? this._state.profile.id : null),
        json: (conn, status, obj, extra) => this._json(conn, status, obj, extra),
        pieces: (conn, status, headers, pieces) => this._sendPieces(conn, status, headers, pieces),
        readBody: (conn, req, rest, max) => this._readBody(conn, req, rest, max),
        homeMayHaveMoved: () => this._homeMayHaveMoved(),
        log: (line) => this._log(line)
      }
    })
    const phone = new PhoneSource({
      dir: o.dir,
      artDir: typeof o.artDir === 'string' && o.artDir !== '' ? o.artDir : null,
      send: typeof o.send === 'function' ? o.send : noop,
      fs: o.fs,
      now: o.now,
      lookups: o.lookups || {},
      person,
      host: {
        profileId: () => (this._state !== null && this._state.profile !== null ? this._state.profile.id : null),
        realSources: () => (this._state !== null ? this._state.sources.map((s) => s.id) : []),
        home: () => this._home(),
        forward: (conn, req, fwd, rest) => this._forward(conn, req, fwd, rest),
        send: (conn, status, headers, body) => this._send(conn, status, headers, body),
        json: (conn, status, obj, extra) => this._json(conn, status, obj, extra),
        pieces: (conn, status, headers, pieces) => this._sendPieces(conn, status, headers, pieces),
        readBody: (conn, req, rest) => this._readBody(conn, req, rest),
        homeMayHaveMoved: () => this._homeMayHaveMoved(),
        log: (line) => this._log(line)
      }
    })
    try {
      phone.start()
      this._phone = phone
      this._phonePerson = person
    } catch (err) {
      this._log('the music of the phone could not be opened: ' + ((err && err.message) || err))
    }
  }

  /** A message from the host for the phone's own music. */
  phoneMessage (msg) {
    if (this._phone !== null && !this._stopping) this._phone.message(msg)
  }

  /**
   * Where the person's data lives: the real principal; the phone store ("0000")
   * while there is none, or while it still holds data that has to move there;
   * null on a host without phone music and no source.
   */
  _home () {
    const p = this._state !== null ? this._state.sources.find((s) => s.principal) : undefined
    if (this._phone === null) return p !== undefined ? p.id : null
    if (p === undefined || this._phone.personHolds()) return PHONE_ID
    return p.id
  }

  _listen () {
    return new Promise((resolve, reject) => {
      const server = net.createServer({ allowHalfOpen: true }, (socket) => this._onConnection(socket))
      const onerror = (err) => reject(err)
      server.once('error', onerror)
      server.listen(this._port, '127.0.0.1', () => {
        server.off('error', onerror)
        server.on('error', (err) => this._log('local server error: ' + (err && err.message)))
        const addr = server.address()
        this._boundPort = addr.port
        this._origin = 'http://127.0.0.1:' + addr.port
        this._server = server
        resolve()
      })
    })
  }

  stop () {
    if (this._stopPromise === null) this._stopPromise = this._stop()
    return this._stopPromise
  }

  async _stop () {
    this._stopping = true
    if (this._startPromise !== null) {
      try {
        await this._startPromise
      } catch {}
    }
    this._running = false
    // A device admitted only for a recovery that never finished is forgotten there.
    await this._endSessions()
    await this._teardown()
    // Every photo change and state write asked for until now lands before stop()
    // resolves (a photo change ends with a state write).
    for (let chain = null; chain !== this._photoChain;) {
      chain = this._photoChain
      try {
        await chain
      } catch {}
    }
    for (let chain = null; chain !== this._chain;) {
      chain = this._chain
      try {
        await chain
      } catch {}
    }
    if (this._chats !== null) await this._chats.settle()
  }

  async _teardown () {
    if (this._phone !== null) {
      const phone = this._phone
      this._phone = null
      await phone.stop()
    }
    if (this._phonePerson !== null) {
      const person = this._phonePerson
      this._phonePerson = null
      await person.stop()
    }
    const server = this._server
    this._server = null
    const closing = server !== null ? new Promise((resolve) => server.close(() => resolve())) : Promise.resolve()
    for (const socket of [...this._sockets]) socket.destroy()
    const runtimes = [...this._sources.values()]
    this._sources.clear()
    await Promise.all(runtimes.map((rt) => this._closeRuntime(rt)))
    await closing
    if (this._dht !== null) {
      this._dht.off('network-change', this._onNetworkChange)
      if (this._dht !== this._extDht) await this._dht.destroy()
      this._dht = null
    }
  }

  refresh () {
    for (const rt of this._sources.values()) {
      rt.meter.reset()
      rt.link.refresh()
    }
    // A lookup of the phone's music held by a metered network tries again.
    if (this._phone !== null) this._phone.networkChanged()
  }

  state () {
    return {
      running: this._running,
      port: this._boundPort,
      publicKey: this._keyPair !== null ? this._keyPair.publicKey : null,
      profileId: this._state !== null && this._state.profile !== null ? this._state.profile.id : null,
      connections: this._sockets.size,
      sources: this._state === null
        ? []
        : this._state.sources.map((s) => {
          const rt = this._sources.get(s.id)
          return { ...this._entry(s), serverPublicKey: s.serverPublicKey, stats: rt ? rt.link.stats : null }
        })
    }
  }

  // --------------------------------------------------------------- events

  _emit (event) {
    if (this._onEvent === null || this._stopping) return
    try {
      this._onEvent(event)
    } catch (err) {
      this._log('onEvent failed: ' + (err && err.message))
    }
  }

  // The event goes out whenever the list changes, and on a host with phone music
  // whenever the home changes (the home alone too); `home` only there.
  _emitSources () {
    if (this._phone === null) {
      this._emit({ type: 'sources', sources: this._list() })
      return
    }
    const home = this._home()
    this._homeSaid = home
    this._phone.sourcesChanged()
    this._emit({ type: 'sources', sources: this._list(), home })
  }

  /** The home may have moved with no change of the list: said when it did. */
  _homeMayHaveMoved () {
    if (this._phone !== null && this._home() !== this._homeSaid) this._emitSources()
  }

  _emitIdentity () {
    const st = this._state
    if (st === null || st.profile === null) return
    this._emit({ type: 'identity', fileName: identityFileName(st.profile.name), identity: buildIdentity(st) })
  }

  _profileView () {
    const p = this._state.profile
    return p === null ? null : { id: p.id, name: p.name, nameUpdatedAt: p.nameUpdatedAt, photo: p.photo, pid: profileIdText(p.id) }
  }

  // ------------------------------------------------------------ sources

  _addRuntime (entry) {
    const link = new MPfyLink({ serverPublicKey: entry.serverPublicKey, keyPair: this._keyPair, dht: this._dht })
    const rt = {
      id: entry.id,
      serverPublicKey: entry.serverPublicKey,
      link,
      meter: new ThroughputMeter(),
      statusKey: null,
      removing: null,
      closed: false,
      connected: false,
      proof: null, // the profile headers for this source, made once
      syncing: false,
      syncNext: null, // a sync asked while one runs: it runs after
      syncTimer: null,
      firstSync: deferred(), // the end of the first sync while connected
      recoveryAt: null, // the recovery blob's updatedAt the source confirmed
      people: null, // the last GET /api/people: { profileId, etag, at, offset, people }
      peopleFetch: null, // that request while it runs
      activity: { inflight: false, waiting: null, lastStart: 0, timer: null } // reports, one at a time
    }
    link.on('status', (status) => this._onLinkStatus(rt, status))
    this._sources.set(entry.id, rt)
    link.start()
    return rt
  }

  async _closeRuntime (rt) {
    rt.closed = true
    this._stopSyncTimer(rt)
    clearTimeout(rt.activity.timer)
    rt.activity.timer = null
    rt.activity.waiting = null
    rt.firstSync.resolve()
    await rt.link.close().catch(noop)
  }

  // The device key changed (an identity brought in): new links for every source.
  _restartLinks () {
    const old = [...this._sources.values()]
    this._sources.clear()
    for (const rt of old) this._closeRuntime(rt)
    this._keyPair = keyPairFromSeed(this._state.clientSeed)
    this._profileKeys = null
    if (this._stopping) return
    for (const entry of this._state.sources) this._addRuntime(entry)
  }

  _onLinkStatus (rt, status) {
    if (!status.connected) rt.meter.reset()
    if (status.connected !== rt.connected && !rt.closed) {
      rt.connected = status.connected
      if (status.connected) {
        this._startSyncTimer(rt)
        this._sync(rt)
        if (this._chats !== null) this._chats.linkUp(rt)
      } else {
        this._stopSyncTimer(rt)
      }
    }
    const key = status.connected + '|' + status.lastError
    if (key === rt.statusKey) return
    rt.statusKey = key
    if (this._sources.get(rt.id) === rt) this._emitSources()
  }

  _entry (s) {
    const rt = this._sources.get(s.id)
    const status = rt !== undefined ? rt.link.status : { connected: false, rttMs: null, lastError: null }
    const connected = status.connected === true
    return {
      id: s.id,
      name: s.name,
      principal: s.principal,
      connected,
      rttMs: connected && Number.isFinite(status.rttMs) ? status.rttMs : null,
      throughputKbps: connected ? rt.meter.kbps() : null,
      lastError: connected ? null : linkErrorWords(status.lastError),
      addedAt: s.addedAt,
      role: s.role,
      named: s.named,
      profiles: s.profiles,
      social: s.social
    }
  }

  _list () {
    return this._state === null ? [] : this._state.sources.map((s) => this._entry(s))
  }

  /**
   * Change the state through fn(draft) -> { result, save }; saved (atomically)
   * before it becomes the current state. One change at a time. A change of the
   * identity gives the recovery blob a new time, so every source gets it again.
   */
  _mutate (fn) {
    const run = this._chain.then(async () => {
      const before = this._state
      const draft = cloneState(before)
      const { result, save } = fn(draft)
      if (save) {
        if (draft.recovery !== null && before.recovery !== null && draft.recovery.updatedAt === before.recovery.updatedAt &&
            identityKey(draft) !== identityKey(before)) {
          draft.recovery.updatedAt = Math.max(Date.now(), before.recovery.updatedAt + 1)
        }
        await writeStateFile(this._statePath, draft)
        this._state = draft
        this._afterChange(before, draft)
      }
      return result
    })
    this._chain = run.then(noop, noop)
    return run
  }

  _afterChange (before, after) {
    // Another profile: nothing of the chats of the last one stays.
    if ((before.profile === null ? null : before.profile.id) !== (after.profile === null ? null : after.profile.id) && this._chats !== null) this._chats.reset()
    let sourcesSaid = false
    if (before.clientSeed !== after.clientSeed) {
      this._restartLinks()
      this._emitSources()
      sourcesSaid = true
    }
    if (!sourcesSaid && sourcesKey(before) !== sourcesKey(after)) this._emitSources()
    if (profileKey(before) !== profileKey(after)) this._emit({ type: 'profile', profile: this._profileView() })
    const fileChanged = identityKey(before) + fileTime(before) !== identityKey(after) + fileTime(after)
    if (fileChanged) this._emitIdentity()
    // Every source gets the new name, photo, blob or deletion now, not in 5
    // minutes. The photo is not in the identity file: it has its own check.
    if (fileChanged || photoKey(before) !== photoKey(after) || after.recoveryDeletes.some((id) => !before.recoveryDeletes.includes(id))) {
      for (const rt of this._sources.values()) this._sync(rt)
    } else if (socialKey(before) !== socialKey(after)) {
      // A change of the settings reaches every social source now; one that fails
      // waits for the next sync.
      for (const rt of this._socialRuntimes()) this._sync(rt)
    }
  }

  async _addSource (body) {
    const code = typeof body.code === 'string' ? body.code : ''
    if (codeKind(code) === 'profile') throw localError('profile_code')
    try {
      parseCode(code)
    } catch {
      throw localError('bad_code')
    }
    let seq = this._removalSeq
    let res = await this._pair(code)
    let key = String(res.serverPublicKey).toLowerCase()
    let id = sourceIdOf(key)
    // A removal of this very source that overlapped the pairing (DELETE
    // /local/sources/<id> in progress, or one that started or ended meanwhile)
    // asks the source to forget this device, possibly AFTER the admission that
    // pairing just made. Let it finish, then pair again: the source is then added
    // anew, and this device is admitted for sure. Each round needs a new removal,
    // so this ends.
    for (;;) {
      const rt = this._sources.get(id)
      const removing = rt !== undefined ? rt.removing : null
      if (removing === null && !(this._removalSeen.get(id) > seq)) break
      if (removing !== null) {
        try {
          await removing
        } catch {}
      }
      seq = this._removalSeq
      res = await this._pair(code)
      key = String(res.serverPublicKey).toLowerCase()
      id = sourceIdOf(key)
    }
    const outcome = await this._mutate((draft) => {
      // Paired again (admitted again): nothing changes here.
      if (draft.sources.some((s) => s.serverPublicKey === key)) return { result: 'existing', save: false }
      if (draft.sources.some((s) => s.id === id)) return { result: 'clash', save: false }
      draft.sources.push({ id, name: cleanName(res.name) || 'Fonte', serverPublicKey: key, principal: false, addedAt: Date.now(), role: null, named: null, profiles: null, social: null, card: null })
      fixPrincipal(draft.sources)
      return { result: 'added', save: true }
    })
    if (outcome === 'clash') throw localError('failed')
    let rt = this._sources.get(id)
    if (outcome === 'added') {
      this._log('source added: ' + id)
      if (!this._stopping && rt === undefined) rt = this._addRuntime(this._state.sources.find((s) => s.id === id))
    } else if (rt !== undefined) {
      rt.link.refresh() // dial now if it was backing off
    }
    // The first sync tells the role and the source's own name.
    if (rt !== undefined) await withTimeout(outcome === 'added' ? rt.firstSync.promise : this._sync(rt), this._firstSyncWaitMs)
    const entry = this._state.sources.find((s) => s.id === id)
    if (entry === undefined) throw localError('failed') // removed meanwhile
    return [outcome === 'added' ? 201 : 200, { source: this._entry(entry) }]
  }

  async _pair (code) {
    let res
    try {
      res = await pair(code, { keyPair: this._keyPair, name: this._deviceName, dht: this._dht, timeout: this._pairTimeoutMs })
    } catch (err) {
      if (err && err.code === 'INVALID_CODE') throw localError('bad_code')
      if (err && err.code === 'UNREACHABLE') throw localError('unreachable')
      if (err && err.code === 'REFUSED') throw localError('refused')
      throw err
    }
    if (this._stopping) throw new HttpError(503, 'Qualcosa non ha funzionato')
    return res
  }

  async _patchSource (id, body) {
    // The name comes from the source itself: no local names.
    if (body.principal !== true || Object.keys(body).some((k) => k !== 'principal')) throw localError('bad_request')
    await this._mutate((draft) => {
      const s = draft.sources.find((x) => x.id === id)
      if (s === undefined) throw new HttpError(404, 'Fonte sconosciuta')
      for (const x of draft.sources) x.principal = x === s
      return { result: null, save: true }
    })
    return [200, { source: this._entry(this._state.sources.find((s) => s.id === id)) }]
  }

  async _removeSource (id) {
    const rt = this._sources.get(id)
    if (rt === undefined) throw new HttpError(404, 'Fonte sconosciuta')
    if (rt.removing === null) {
      this._removalSeen.set(id, ++this._removalSeq)
      const removing = this._doRemove(rt)
      rt.removing = removing
      removing.then(() => {
        this._removalSeen.set(id, ++this._removalSeq)
      }, () => {
        rt.removing = null
        this._removalSeen.set(id, ++this._removalSeq)
      })
    }
    const revoked = await rt.removing
    return [200, { ok: true, revoked }]
  }

  async _doRemove (rt) {
    // Ask the source to forget this device first, when it answers within 2 s.
    let revoked = false
    try {
      const res = await rt.link.request('DELETE', '/api/admin/clients/self', { headers: this._proofHeaders(rt) || {}, timeout: this._revokeTimeoutMs })
      revoked = res.status === 200 || res.status === 404 // 404: it did not know this device anymore
      if (!revoked) this._log('source ' + rt.id + ' refused to forget this device (' + res.status + ')')
    } catch (err) {
      this._log('source ' + rt.id + ' not reached to forget this device (' + ((err && (err.detail || err.code)) || err) + ')')
    }
    await this._mutate((draft) => {
      const i = draft.sources.findIndex((s) => s.id === rt.id)
      if (i === -1) return { result: null, save: false }
      draft.sources.splice(i, 1)
      fixPrincipal(draft.sources)
      draft.recoveryDeletes = draft.recoveryDeletes.filter((x) => x !== rt.id)
      return { result: null, save: true }
    })
    if (this._sources.get(rt.id) === rt) this._sources.delete(rt.id)
    await this._closeRuntime(rt)
    this._chats.forgetSource(rt.id)
    this._log('source removed: ' + rt.id + (revoked ? ' (this device forgotten there)' : ''))
    return revoked
  }

  // ------------------------------------------------------------- the profile

  _proofHeaders (rt) {
    const p = this._state.profile
    if (p === null) return null
    const clientKey = this._keyPair.publicKey
    if (rt.proof === null || rt.proof.profileId !== p.id || rt.proof.clientKey !== clientKey) {
      rt.proof = { profileId: p.id, clientKey, headers: proofHeaders(this._keys(), clientKey, rt.serverPublicKey) }
    }
    return rt.proof.headers
  }

  // The keys of the current profile (it must have one), made once.
  _keys () {
    const p = this._state.profile
    if (this._profileKeys === null || this._profileKeys.id !== p.id) this._profileKeys = profileKeys(p.secret)
    return this._profileKeys
  }

  // One profile creation, import or recovery at a time.
  _identityOp (fn) {
    const run = this._identityChain.then(fn)
    this._identityChain = run.then(noop, noop)
    return run
  }

  _getProfile () {
    const p = this._state.profile
    return [200, { profile: this._profileView(), recovery: this._state.recovery !== null, fileName: p === null ? null : identityFileName(p.name) }]
  }

  async _createProfile (body) {
    if (this._state.profile !== null) throw localError('profile_exists')
    const name = cleanProfileName(body.name)
    if (name === null) throw localError('bad_name')
    return this._identityOp(async () => {
      const keys = profileKeys(newProfileSecret())
      const now = Date.now()
      await this._mutate((draft) => {
        if (draft.profile !== null) throw localError('profile_exists')
        draft.profile = { id: keys.id, secret: keys.secret, name, nameUpdatedAt: now, createdAt: now, photo: null, photoUpdatedAt: 0 }
        draft.recovery = null
        draft.recoveryDeletes = []
        draft.social = defaultSocial()
        for (const s of draft.sources) s.card = null
        return { result: null, save: true }
      })
      this._log('profile created: ' + keys.id)
      await this._sweepPhotos()
      await this._endSessions()
      return [201, { profile: this._profileView() }]
    })
  }

  async _renameProfile (body) {
    if (this._state.profile === null) throw localError('no_profile')
    const name = cleanProfileName(body.name)
    if (name === null) throw localError('bad_name')
    await this._mutate((draft) => {
      if (draft.profile === null) throw localError('no_profile')
      draft.profile.name = name
      draft.profile.nameUpdatedAt = Math.max(Date.now(), draft.profile.nameUpdatedAt + 1)
      return { result: null, save: true }
    })
    return [200, { profile: this._profileView() }]
  }

  // ------------------------------------------------------------- the photo

  // One change of the photo (and of its files) at a time.
  _photoOp (fn) {
    const run = this._photoChain.then(fn)
    this._photoChain = run.then(noop, noop)
    return run
  }

  // Every photo file the state does not point to goes.
  _sweepPhotos () {
    return this._photoOp(() => {
      const p = this._state.profile
      sweepPhotos(this._statePath, p !== null ? p.photo : null)
    })
  }

  /**
   * Set the photo of profile `profileId`: `bytes` (already checked, with their
   * `hash`), or null for none. at: a time a source gave, taken only when that
   * photo wins over the one here (photoWins: newer, or the same time and a
   * greater hash); null for a change made here (now, always newer). The new file
   * is written before the state points to it, and the file the state no longer
   * points to goes after. Resolves true when the state took the change.
   */
  _changePhoto (profileId, bytes, hash, at) {
    return this._photoOp(async () => {
      if (this._stopping) return false
      const takes = (p) => p !== null && p.id === profileId && (at === null || photoWins(at, hash, p.photoUpdatedAt, p.photo))
      if (!takes(this._state.profile)) return false
      const previous = this._state.profile.photo
      try {
        if (hash !== null) await writePhoto(this._statePath, hash, bytes)
        return await this._mutate((draft) => {
          const p = draft.profile
          // Checked again: a change made here may have landed meanwhile.
          if (!takes(p)) return { result: false, save: false }
          p.photo = hash
          p.photoUpdatedAt = at !== null ? at : Math.max(Date.now(), p.photoUpdatedAt + 1)
          return { result: true, save: true }
        })
      } finally {
        // What the state does not point to now: the old file once replaced, the
        // new one when the change was not taken or not saved.
        const keep = this._state.profile !== null ? this._state.profile.photo : null
        for (const h of [previous, hash]) if (h !== null && h !== keep) removePhoto(this._statePath, h)
      }
    })
  }

  // A change of the photo made here, by the page.
  async _localPhotoChange (bytes, hash) {
    if (this._state.profile === null) throw localError('no_profile')
    if (!(await this._changePhoto(this._state.profile.id, bytes, hash, null))) {
      if (this._state.profile === null) throw localError('no_profile')
      throw new HttpError(503, 'Qualcosa non ha funzionato') // stopping
    }
    return [200, { profile: this._profileView() }]
  }

  // PUT /local/profile/photo: the JPEG's own bytes as the body.
  _putPhoto (req, body) {
    if (this._state.profile === null) throw localError('no_profile')
    if (!isJpegType(req.map['content-type']) || !validPhoto(body)) throw localError('bad_photo')
    return this._localPhotoChange(body, photoHash(body))
  }

  // DELETE /local/profile/photo. Always a change, also with no photo here: the
  // person removed it now, so this is the newest word on it everywhere, and a
  // photo another device set earlier (not heard of here yet) must not come back
  // after it. Sent twice, it is the same outcome with a newer time.
  _deletePhoto () {
    return this._localPhotoChange(null, null)
  }

  // GET or HEAD /local/profile/photo: the bytes, for an <img> of the page.
  _photoAnswer (req) {
    const p = this._state.profile
    if (p === null) throw localError('no_profile')
    if (p.photo === null) throw localError('no_photo')
    const etag = '"' + p.photo + '"'
    const headers = { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache', ETag: etag }
    if (etagMatches(req.map['if-none-match'], etag)) return { status: 304, headers, body: null }
    const bytes = readPhoto(this._statePath, p.photo)
    if (bytes === null) throw localError('no_photo')
    return { status: 200, headers: { ...headers, 'Content-Length': bytes.byteLength }, body: bytes }
  }

  _profileCode () {
    const p = this._state.profile
    if (p === null) throw localError('no_profile')
    return [200, { code: formatProfileCode(p.secret) }]
  }

  _export () {
    const p = this._state.profile
    if (p === null) throw localError('no_profile')
    return [200, { fileName: identityFileName(p.name), identity: buildIdentity(this._state) }]
  }

  async _import (body) {
    if (this._state.profile !== null) throw localError('profile_exists')
    if (body.identity !== undefined && body.identity !== null) {
      const identity = parseIdentity(body.identity)
      if (identity === null) throw localError('bad_file')
      return this._identityOp(() => this._adoptIdentity(identity, identity.recovery))
    }
    if (body.code !== undefined) {
      const code = typeof body.code === 'string' ? body.code : ''
      if (codeKind(code) === 'source') throw localError('source_code')
      const secret = parseProfileCode(code)
      if (secret === null) throw localError('bad_code')
      return this._identityOp(async () => {
        const keys = profileKeys(secret)
        // The name comes from the first source that knows the profile, else the page asks it.
        await this._mutate((draft) => {
          if (draft.profile !== null) throw localError('profile_exists')
          draft.profile = { id: keys.id, secret: keys.secret, name: '', nameUpdatedAt: 0, createdAt: Date.now(), photo: null, photoUpdatedAt: 0 }
          draft.recovery = null
          draft.recoveryDeletes = []
          // The settings come back from the sources that know the profile.
          draft.social = defaultSocial()
          for (const s of draft.sources) s.card = null
          return { result: null, save: true }
        })
        this._log('profile brought in by its code: ' + keys.id)
        await this._sweepPhotos()
        await this._endSessions()
        return [200, { profile: this._profileView(), sources: this._list() }]
      })
    }
    throw localError('bad_request')
  }

  /**
   * Become the device an identity describes: its key, its profile, its sources.
   * Every source of the current state is asked first to forget the key that goes
   * (skipping `forgotten`, already asked), unless the key stays the same.
   */
  async _adoptIdentity (identity, recovery, forgotten = null) {
    if (this._state.profile !== null) throw localError('profile_exists')
    if (identity.clientSeed !== this._state.clientSeed) {
      await Promise.all(this._state.sources.map((s) => {
        const rt = this._sources.get(s.id)
        return rt !== undefined && s.serverPublicKey !== forgotten ? this._forgetMe(rt.link) : null
      }))
    }
    const { sources } = normalizeSources(identity.sources)
    for (const s of sources) {
      s.role = null
      s.named = null
      s.profiles = null
      s.social = null
      s.card = null
    }
    await this._mutate((draft) => {
      if (draft.profile !== null) throw localError('profile_exists')
      draft.clientSeed = identity.clientSeed
      // The identity file has no photo: the sources give it at their first sync.
      draft.profile = { ...identity.profile, createdAt: Date.now(), photo: null, photoUpdatedAt: 0 }
      draft.sources = sources
      draft.recovery = recovery
      draft.recoveryDeletes = []
      // Neither are the settings: the sources give them back.
      draft.social = defaultSocial()
      return { result: null, save: true }
    })
    this._log('identity brought in: profile ' + identity.profile.id + ', ' + sources.length + ' source(s)')
    await this._sweepPhotos()
    await this._endSessions()
    return [200, { profile: this._profileView(), sources: this._list() }]
  }

  // Ask a source to forget this device (2 s, best effort). Without the profile
  // headers: only used while there is no profile.
  async _forgetMe (link) {
    try {
      const res = await link.request('DELETE', '/api/admin/clients/self', { timeout: this._revokeTimeoutMs })
      return res.status === 200 || res.status === 404
    } catch {
      return false
    }
  }

  async _enableRecovery (body) {
    if (this._state.profile === null) throw localError('no_profile')
    if (!passwordLongEnough(body.password)) throw localError('short_password')
    return this._identityOp(async () => {
      const salt = randomBytes(16)
      const keys = await deriveRecoveryKeys(body.password, salt)
      await this._mutate((draft) => {
        if (draft.profile === null) throw localError('no_profile')
        const before = draft.recovery !== null ? draft.recovery.updatedAt : 0
        draft.recovery = {
          salt: b4a.toString(salt, 'hex'),
          opslimit: OPSLIMIT,
          memlimit: MEMLIMIT,
          encKey: b4a.toString(keys.encKey, 'hex'),
          verifierHash: b4a.toString(keys.verifierHash, 'hex'),
          updatedAt: Math.max(Date.now(), before + 1)
        }
        draft.recoveryDeletes = [] // the new blob replaces whatever is there
        return { result: null, save: true }
      })
      const target = this._state.recovery.updatedAt
      await withTimeout(Promise.all(this._connected().map((rt) => this._sync(rt))), SYNC_TIMEOUT_MS)
      const sources = {}
      for (const s of this._state.sources) {
        const rt = this._sources.get(s.id)
        sources[s.id] = rt !== undefined && rt.recoveryAt === target ? 'ok' : 'pending'
      }
      return [200, { recovery: true, sources }]
    })
  }

  async _disableRecovery () {
    await this._identityOp(() => this._mutate((draft) => {
      if (draft.profile === null) return { result: null, save: false }
      draft.recovery = null
      for (const s of draft.sources) if (!draft.recoveryDeletes.includes(s.id)) draft.recoveryDeletes.push(s.id)
      return { result: null, save: true }
    }))
    return [200, { recovery: false }]
  }

  _connected () {
    return [...this._sources.values()].filter((rt) => rt.link.status.connected)
  }

  async _syncAll () {
    await withTimeout(Promise.all(this._connected().map((rt) => this._sync(rt))), SYNC_TIMEOUT_MS)
    return [200, { ok: true }]
  }

  // ------------------------------------------------------------------ sync

  _startSyncTimer (rt) {
    if (rt.syncTimer !== null) return
    rt.syncTimer = setInterval(() => this._sync(rt), this._syncEveryMs)
    if (typeof rt.syncTimer.unref === 'function') rt.syncTimer.unref()
  }

  _stopSyncTimer (rt) {
    if (rt.syncTimer === null) return
    clearInterval(rt.syncTimer)
    rt.syncTimer = null
  }

  /**
   * Sync one source. One at a time per source: asked while one runs, another
   * runs right after it. Resolves when a sync that started after the call is
   * over; never rejects.
   */
  _sync (rt) {
    if (rt.closed) return Promise.resolve()
    if (rt.syncing) {
      if (rt.syncNext === null) rt.syncNext = deferred()
      return rt.syncNext.promise
    }
    rt.syncing = true
    return this._syncOnce(rt).catch((err) => {
      this._log('sync of ' + rt.id + ' failed: ' + ((err && (err.detail || err.code || err.message)) || err))
    }).then(() => {
      rt.syncing = false
      const next = rt.syncNext
      if (next !== null) {
        rt.syncNext = null
        this._sync(rt).then(next.resolve)
      }
    })
  }

  _live (rt) {
    return !this._stopping && !rt.closed && rt.removing === null && this._sources.get(rt.id) === rt
  }

  async _syncOnce (rt) {
    if (!this._live(rt) || !rt.link.status.connected) return
    try {
      await this._syncSource(rt)
    } finally {
      rt.firstSync.resolve()
    }
  }

  // A request of this core to a source, with the profile headers.
  async _ask (rt, method, path, body = null) {
    const res = await this._askRaw(rt, method, path, body)
    return { status: res.status, data: parseJsonOrNull(res.body) }
  }

  // The same, with the answer's bytes as they came (the photo).
  _askRaw (rt, method, path, body = null) {
    return rt.link.request(method, path, { headers: this._proofHeaders(rt) || {}, body, timeout: SYNC_TIMEOUT_MS })
  }

  async _syncSource (rt) {
    const res = await this._ask(rt, 'GET', '/api/profile')
    if (!this._live(rt)) return
    if (res.status === 404) {
      // A source without profiles: everything as before them.
      await this._setSourceInfo(rt.id, { role: null, named: null, profiles: false, social: 0 })
      return
    }
    const p = res.data
    if (res.status !== 200 || !profileAnswer(p)) {
      this._log('sync of ' + rt.id + ': profile not read (' + res.status + (p && p.code ? ' ' + p.code : '') + ')')
      return
    }
    // With the role, in one change: never profiles true and the role still unknown.
    await this._setSourceInfo(rt.id, { role: roleOf(p.role), named: p.source.named === true, name: cleanName(p.source.name), profiles: true, social: socialLevel(p) })
    const profile = this._state.profile
    if (profile === null || p.profileId !== profile.id || !this._live(rt)) return
    await this._syncName(rt, p)
    if (!this._live(rt)) return
    // A photo that cannot be sent or taken never holds back the recovery blob.
    try {
      await this._syncPhoto(rt, p)
    } catch (err) {
      this._log('sync of ' + rt.id + ': photo not synced (' + ((err && (err.detail || err.code || err.message)) || err) + ')')
    }
    if (!this._live(rt)) return
    // Nor do the settings and the card.
    try {
      await this._syncSocial(rt, p)
    } catch (err) {
      this._log('sync of ' + rt.id + ': social part not synced (' + ((err && (err.detail || err.code || err.message)) || err) + ')')
    }
    if (!this._live(rt)) return
    await this._syncRecovery(rt, p)
  }

  _setSourceInfo (id, info) {
    const s = this._state.sources.find((x) => x.id === id)
    if (s === undefined || this._stopping) return null
    const changes = {}
    for (const k of Object.keys(info)) {
      if (k === 'name' && info.name === '') continue // never an empty name
      if (s[k] !== info[k]) changes[k] = info[k]
    }
    if (Object.keys(changes).length === 0) return null
    return this._mutate((draft) => {
      const d = draft.sources.find((x) => x.id === id)
      if (d === undefined) return { result: null, save: false }
      Object.assign(d, changes)
      return { result: null, save: true }
    })
  }

  // The newest name wins; an empty one is never taken from a source, nor one
  // whose time could not be real (it would hold back every later rename).
  async _syncName (rt, p) {
    const local = this._state.profile
    const at = sourceTime(p.nameUpdatedAt)
    const name = typeof p.name === 'string' && at !== null ? p.name : ''
    if (local.name === '') {
      if (name !== '') await this._adoptName(local.id, name, at)
    } else if (name === '' || at < local.nameUpdatedAt) {
      const res = await this._ask(rt, 'PATCH', '/api/profile', { name: local.name, nameUpdatedAt: local.nameUpdatedAt })
      if (res.status !== 200) this._log('sync of ' + rt.id + ': name not sent (' + res.status + ')')
    } else if (at > local.nameUpdatedAt) {
      await this._adoptName(local.id, name, at)
    }
  }

  _adoptName (profileId, value, at) {
    const name = cleanProfileName(value)
    if (name === null || this._stopping) return null
    return this._mutate((draft) => {
      const p = draft.profile
      if (p === null || p.id !== profileId || !(p.name === '' || at > p.nameUpdatedAt)) return { result: null, save: false }
      p.name = name
      p.nameUpdatedAt = at
      return { result: null, save: true }
    })
  }

  // The newest photo wins, and a removal is a change like any other; at the very
  // same time the greater hash wins (photoWins), as on the sources. A source that
  // says nothing about photos (one from before them) is left alone; a time that
  // could not be real counts as none there, like the name's. When both sides hold
  // the same photo at the same time nothing is asked at all.
  async _syncPhoto (rt, p) {
    if (p.photoUpdatedAt === undefined) return
    const hash = p.photo === null || isPhotoHash(p.photo) ? p.photo : undefined
    const at = hash !== undefined ? sourceTime(p.photoUpdatedAt) : null
    const local = this._state.profile
    if (photoWins(local.photoUpdatedAt, local.photo, at === null ? 0 : at, at === null ? null : hash)) {
      // Read together with the state: the file is the one the state names.
      const bytes = local.photo !== null ? readPhoto(this._statePath, local.photo) : null
      if (local.photo !== null && bytes === null) {
        this._log('sync of ' + rt.id + ': photo not sent (its file is missing)')
        return
      }
      const res = await this._ask(rt, 'PUT', '/api/profile/photo', {
        photo: bytes !== null ? b4a.toString(bytes, 'base64') : null, photoUpdatedAt: local.photoUpdatedAt
      })
      if (res.status !== 200) this._log('sync of ' + rt.id + ': photo not sent (' + res.status + ')')
    } else if (at !== null && photoWins(at, hash, local.photoUpdatedAt, local.photo)) {
      if (hash === null) {
        await this._changePhoto(local.id, null, null, at)
        return
      }
      const res = await this._askRaw(rt, 'GET', '/api/profile/photo')
      if (!this._live(rt)) return
      // Only the photo the source announced: the bytes must hash to it.
      if (res.status !== 200 || !validPhoto(res.body) || photoHash(res.body) !== hash) {
        this._log('sync of ' + rt.id + ': photo not taken (' + (res.status !== 200 ? res.status : 'not the one announced') + ')')
        return
      }
      await this._changePhoto(local.id, res.body, hash, at)
    }
  }

  async _syncRecovery (rt, p) {
    const r = this._state.recovery
    const held = p.recovery !== null && typeof p.recovery === 'object'
    if (r !== null) {
      const there = held && Number.isFinite(p.recovery.updatedAt) ? p.recovery.updatedAt : null
      if (there === r.updatedAt) rt.recoveryAt = there
      else await this._putRecovery(rt)
    }
    // Recovery off here: no blob of this device stays on a source, neither one
    // whose deletion waited for it nor one an earlier state of this device left
    // there (an identity file from before recovery was turned on).
    const stale = held && this._state.recovery === null
    if (!this._live(rt) || !(stale || this._state.recoveryDeletes.includes(rt.id))) return
    const res = await this._ask(rt, 'DELETE', '/api/recovery')
    if (res.status !== 200) {
      this._log('sync of ' + rt.id + ': recovery blob not deleted (' + res.status + ')')
      return
    }
    rt.recoveryAt = null
    if (this._stopping) return
    await this._mutate((draft) => {
      if (!draft.recoveryDeletes.includes(rt.id)) return { result: null, save: false }
      draft.recoveryDeletes = draft.recoveryDeletes.filter((x) => x !== rt.id)
      return { result: null, save: true }
    })
  }

  async _putRecovery (rt) {
    const st = this._state
    const r = st.recovery
    const blob = encryptBlob(identityText(buildIdentity(st, { withRecovery: false })), b4a.from(r.encKey, 'hex'), st.profile.id)
    const res = await this._ask(rt, 'PUT', '/api/recovery', {
      salt: r.salt, opslimit: r.opslimit, memlimit: r.memlimit, verifierHash: r.verifierHash, blob, updatedAt: r.updatedAt
    })
    if (res.status !== 200 || res.data === null || !Number.isFinite(res.data.updatedAt)) {
      this._log('sync of ' + rt.id + ': recovery blob not sent (' + res.status + ')')
      return
    }
    // The time the source keeps for this device, never taken as this device's own
    // (a time a source makes up would hold back every later blob). A source that
    // keeps a newer blob keeps it until this device's time passes it.
    rt.recoveryAt = res.data.updatedAt
    if (rt.recoveryAt !== r.updatedAt) this._log('sync of ' + rt.id + ': the source keeps another recovery blob of this device')
  }

  // ------------------------------------------------------------- social

  // The runtimes of the sources that speak the social part (1 or more).
  _socialRuntimes () {
    const out = []
    if (this._state === null) return out
    for (const s of this._state.sources) {
      if (!(s.social >= 1)) continue
      const rt = this._sources.get(s.id)
      if (rt !== undefined && rt.removing === null && !rt.closed) out.push(rt)
    }
    return out
  }

  // Whether there is anything social to show: a profile and a social source.
  _supported () {
    return this._state.profile !== null && this._state.sources.some((s) => s.social >= 1)
  }

  // This profile's card as it is now: null while it has no name.
  _card () {
    const p = this._state.profile
    if (p === null || p.name === '') return null
    const at = Math.max(p.nameUpdatedAt, p.photoUpdatedAt)
    if (!(at > 0)) return null
    const key = JSON.stringify([p.id, p.name, p.photo, at])
    if (this._cardMade === null || this._cardMade.key !== key) this._cardMade = { key, card: makeCard(this._keys(), p.name, p.photo, at) }
    return this._cardMade.card
  }

  // The settings and the card of one source (after the name and the photo, so
  // the card holds what this source holds). Only for a source at 1 or more. The
  // settings go first: a source that has no card of this profile lists nobody, so
  // an invisible person never shows there, not even between the two requests.
  async _syncSocial (rt, p) {
    const entry = this._state.sources.find((s) => s.id === rt.id)
    if (entry === undefined || !(entry.social >= 1)) return
    const info = p.social !== null && typeof p.social === 'object' ? p.social : {}
    const there = (k) => sourceTime(info[k]) || 0
    // The silent entry in the source's group (a source with chats): made once, as
    // soon as the source holds this profile's card, so a person who is or becomes
    // invisible stays one of its recipients. With the card already there, it goes
    // before the settings (an invisible privacy would drop them from the group).
    let access = !(entry.social >= 2) || there('access') > 0
    if (!access && there('card') > 0 && entry.card !== null) access = await this._putAccess(rt)
    if (!this._live(rt) || this._state.profile === null) return
    // Per section the newest time wins; equal times ask nothing.
    const newerThere = SECTIONS.filter((k) => there(k) > this._state.social[k].updatedAt)
    if (newerThere.length > 0) {
      const res = await this._ask(rt, 'GET', '/api/profile/social')
      if (!this._live(rt)) return
      if (res.status === 200 && res.data !== null) await this._adoptSocial(newerThere, res.data)
      else this._log('sync of ' + rt.id + ': settings not read (' + res.status + ')')
    }
    if (!this._live(rt) || this._state.profile === null) return
    const newerHere = SECTIONS.filter((k) => this._state.social[k].updatedAt > there(k))
    if (newerHere.length > 0) {
      const body = {}
      for (const k of newerHere) body[k] = this._sectionOut(k)
      const res = await this._ask(rt, 'PUT', '/api/profile/social', body)
      if (!this._live(rt)) return
      if (res.status !== 200) {
        this._log('sync of ' + rt.id + ': settings not sent (' + res.status + (res.data && res.data.code ? ' ' + res.data.code : '') + ')')
        // An invisible person's card waits until the source holds the privacy that hides it.
        if (newerHere.includes('privacy') && this._state.social.privacy.invisible) return
      }
    }
    if (this._state.profile === null) return
    await this._syncCard(rt, there('card'))
    if (!access && this._live(rt) && this._state.profile !== null) await this._putAccess(rt)
  }

  // PUT /api/chat/group/access: this profile's silent entry in a source's group,
  // signed with its key. Resolves whether the source took it.
  async _putAccess (rt) {
    const res = await this._ask(rt, 'PUT', '/api/chat/group/access', makeAccess(this._keys(), groupId(rt.serverPublicKey), Date.now()))
    if (res.status !== 200) {
      this._log('sync of ' + rt.id + ': group entry not sent (' + res.status + (res.data && res.data.code ? ' ' + res.data.code : '') + ')')
      return false
    }
    return true
  }

  /**
   * The card goes to a source whose card is older, and to one whose card has the
   * same time but was never confirmed to be this one. When the source keeps
   * another card of the very same time (made by another device of this profile
   * before a change reached it), this one goes out a millisecond later: what this
   * device holds now, synced with that source just before, is the newest.
   */
  async _syncCard (rt, there) {
    const card = this._card()
    const entry = this._state.sources.find((s) => s.id === rt.id)
    if (card === null || entry === undefined || there > card.updatedAt) return
    if (there === card.updatedAt && entry.card === card.sig) return
    let kept = await this._putCard(rt, card)
    if (kept !== null && kept.sig !== card.sig && kept.updatedAt === card.updatedAt && this._live(rt)) {
      kept = await this._putCard(rt, makeCard(this._keys(), card.name, card.photo, card.updatedAt + 1))
    }
    if (kept !== null && this._live(rt)) await this._setSourceInfo(rt.id, { card: kept.sig })
  }

  // PUT /api/profile/card: the card the source keeps, when it is valid and this
  // profile's; else null.
  async _putCard (rt, card) {
    const res = await this._ask(rt, 'PUT', '/api/profile/card', card)
    const kept = res.status === 200 && res.data !== null ? res.data.card : null
    if (!checkCard(kept) || kept.profileId !== card.profileId) {
      this._log('sync of ' + rt.id + ': card not sent (' + res.status + (res.data && res.data.code ? ' ' + res.data.code : '') + ')')
      return null
    }
    return kept
  }

  // The newer sections a source gave: each taken when valid and still newer here.
  // A mutes box that does not open leaves the mutes as they are.
  async _adoptSocial (sections, data) {
    const profile = this._state.profile
    const got = {}
    for (const k of sections) {
      const v = sectionIn(k, data[k], this._keys(), profile.id)
      if (v !== null) got[k] = v
      else this._log('sync: the ' + k + ' of a source left aside (not valid, or not ours to open)')
    }
    if (Object.keys(got).length === 0 || this._stopping) return
    await this._mutate((draft) => {
      if (draft.profile === null || draft.profile.id !== profile.id) return { result: null, save: false }
      let save = false
      for (const k of Object.keys(got)) {
        if (got[k].updatedAt > draft.social[k].updatedAt) {
          draft.social[k] = got[k]
          save = true
        }
      }
      return { result: null, save }
    })
  }

  // A section as the sources take it.
  _sectionOut (k) {
    const s = this._state.social
    if (k === 'privacy') {
      const p = s.privacy
      return { invisible: p.invisible, showNow: p.showNow, privateUntil: p.privateUntil, showRecent: p.showRecent, updatedAt: p.updatedAt }
    }
    if (k === 'blocked') return { ids: s.blocked.ids.slice(), updatedAt: s.blocked.updatedAt }
    return { box: sealMutes(s.mutes.map, this._keys().socialKey), updatedAt: s.mutes.updatedAt }
  }

  _privacyView () {
    const p = this._state.social.privacy
    return { invisible: p.invisible, showNow: p.showNow, privateSession: p.privateUntil > Date.now(), privateUntil: p.privateUntil, showRecent: p.showRecent, updatedAt: p.updatedAt }
  }

  _getSocial () {
    const s = this._state.social
    return [200, { supported: this._supported(), privacy: this._privacyView(), blocked: s.blocked.ids.slice(), mutes: { ...s.mutes.map } }]
  }

  // PATCH /local/social: the switches of the privacy, a new time, every social
  // source told at once.
  async _patchSocial (body) {
    if (this._state.profile === null) throw localError('no_profile')
    const keys = Object.keys(body)
    if (keys.length === 0 || keys.some((k) => !PRIVACY_SWITCHES.includes(k) || typeof body[k] !== 'boolean')) throw localError('bad_request')
    await this._mutate((draft) => {
      if (draft.profile === null) throw localError('no_profile')
      const now = Date.now()
      const p = { ...draft.social.privacy }
      if (body.invisible !== undefined) p.invisible = body.invisible
      if (body.showNow !== undefined) p.showNow = body.showNow
      if (body.showRecent !== undefined) p.showRecent = body.showRecent
      if (body.privateSession !== undefined) p.privateUntil = body.privateSession ? now + PRIVATE_SESSION_MS : 0
      p.updatedAt = Math.max(now, p.updatedAt + 1)
      draft.social.privacy = p
      return { result: null, save: true }
    })
    return [200, { privacy: this._privacyView() }]
  }

  // POST /local/social/blocked { profileId } and DELETE /local/social/blocked/<id>:
  // the block list changes here (a new time) and reaches every social source now.
  async _block (id, on) {
    const p = this._state.profile
    if (p === null) throw localError('no_profile')
    if (typeof id !== 'string' || !HEX32_RE.test(id) || id === p.id) throw localError('bad_request')
    await this._mutate((draft) => {
      if (draft.profile === null) throw localError('no_profile')
      const b = draft.social.blocked
      if (b.ids.includes(id) === on) return { result: null, save: false }
      draft.social.blocked = { ids: on ? [...b.ids, id] : b.ids.filter((x) => x !== id), updatedAt: Math.max(Date.now(), b.updatedAt + 1) }
      return { result: null, save: true }
    })
    return [200, { blocked: this._state.social.blocked.ids.slice() }]
  }

  // PUT /local/chat/<cid>/mute { mute }: the mutes of every id of that
  // conversation, sealed for this profile's devices and sent to every social source.
  async _mute (cid, body) {
    if (this._state.profile === null) throw localError('no_profile')
    const map = this._chats.mutesFor(cid, body, this._state.social.mutes.map)
    await this._mutate((draft) => {
      if (draft.profile === null) throw localError('no_profile')
      draft.social.mutes = { map, updatedAt: Math.max(Date.now(), draft.social.mutes.updatedAt + 1) }
      return { result: null, save: true }
    })
    return [200, { mutes: { ...this._state.social.mutes.map } }]
  }

  // Nothing about what is playing goes out while invisible, during a private
  // session, or with both switches off.
  _activityQuiet () {
    const p = this._state.social.privacy
    return p.invisible || p.privateUntil > Date.now() || (!p.showNow && !p.showRecent)
  }

  // PUT /local/activity { track, playing }: answered at once; every connected
  // social source gets it, one request at a time each, the latest call replacing
  // one still waiting, at least ACTIVITY_GAP_MS between two starts.
  _putActivity (body) {
    if (this._state.profile === null) throw localError('no_profile')
    const report = activityIn(body)
    if (!this._activityQuiet()) {
      for (const rt of this._socialRuntimes()) {
        if (!rt.link.status.connected) continue // down: the next report covers it
        rt.activity.waiting = report
        this._pumpActivity(rt)
      }
    }
    return [200, { ok: true }]
  }

  _pumpActivity (rt) {
    const a = rt.activity
    if (a.inflight || a.waiting === null || rt.closed) return
    const wait = a.lastStart + this._activityGapMs - Date.now()
    if (wait > 0) {
      if (a.timer === null) {
        a.timer = setTimeout(() => {
          a.timer = null
          this._pumpActivity(rt)
        }, wait)
        if (typeof a.timer.unref === 'function') a.timer.unref()
      }
      return
    }
    const report = a.waiting
    a.waiting = null
    if (!this._live(rt) || !rt.link.status.connected || this._state.profile === null || this._activityQuiet()) return
    const p = this._state.social.privacy
    a.inflight = true
    a.lastStart = Date.now()
    this._ask(rt, 'PUT', '/api/activity', { track: report.track, playing: report.playing, now: p.showNow, recent: p.showRecent }).then((res) => {
      if (res.status !== 200) this._log('activity not taken by ' + rt.id + ' (' + res.status + (res.data && res.data.code ? ' ' + res.data.code : '') + ')')
    }, (err) => {
      this._log('activity not sent to ' + rt.id + ' (' + ((err && (err.detail || err.code || err.message)) || err) + ')')
    }).then(() => {
      a.inflight = false
      this._pumpActivity(rt)
    })
  }

  // ------------------------------------------------------------- people

  // The last people answer of a source, when it was read for this profile.
  _peopleOf (rt) {
    const c = rt.people
    const p = this._state.profile
    return c !== null && p !== null && c.profileId === p.id ? c : null
  }

  // Every connected social source whose list is older than PEOPLE_FRESH_MS is
  // read again, in parallel; this waits PEOPLE_WAIT_MS at most (what comes later
  // is kept for the next call).
  async _refreshPeople () {
    const now = Date.now()
    const due = []
    for (const rt of this._socialRuntimes()) {
      if (!rt.link.status.connected) continue
      const c = this._peopleOf(rt)
      if (c === null || now - c.at >= this._peopleFreshMs) due.push(this._fetchPeople(rt))
    }
    if (due.length > 0) await withTimeout(Promise.all(due), PEOPLE_WAIT_MS)
  }

  _fetchPeople (rt) {
    if (rt.peopleFetch !== null) return rt.peopleFetch
    const run = this._loadPeople(rt).catch((err) => {
      this._log('people of ' + rt.id + ' not read (' + ((err && (err.detail || err.code || err.message)) || err) + ')')
    }).then(() => {
      rt.peopleFetch = null
    })
    rt.peopleFetch = run
    return run
  }

  async _loadPeople (rt) {
    const profile = this._state.profile
    if (profile === null) return
    const cached = this._peopleOf(rt)
    const headers = { ...(this._proofHeaders(rt) || {}) }
    if (cached !== null && cached.etag !== null) headers['If-None-Match'] = cached.etag
    const res = await rt.link.request('GET', '/api/people', { headers, timeout: PEOPLE_TIMEOUT_MS })
    const at = Date.now()
    if (this._state.profile === null || this._state.profile.id !== profile.id) return
    if (res.status === 304 && cached !== null) {
      cached.at = at
      return
    }
    const data = res.status === 200 ? parseJsonOrNull(res.body) : null
    if (data === null || !Number.isSafeInteger(data.time) || !Array.isArray(data.people)) {
      this._log('people of ' + rt.id + ' not read (' + res.status + ')')
      return
    }
    const etag = typeof res.headers.etag === 'string' && res.headers.etag !== '' ? res.headers.etag : null
    rt.people = { profileId: profile.id, etag, at, offset: at - data.time, people: data.people }
  }

  _badCard (source, profileId) {
    const key = source + '|' + profileId
    if (this._badCards.has(key)) return
    if (this._badCards.size >= BAD_CARDS_KEPT) this._badCards.clear()
    this._badCards.add(key)
    this._log('a card from ' + source + ' for profile ' + profileId + ' does not verify: left out')
  }

  // The union of what the social sources listed last.
  _union () {
    const answers = []
    for (const rt of this._socialRuntimes()) {
      const c = this._peopleOf(rt)
      if (c !== null) answers.push({ source: rt.id, offset: c.offset, people: c.people })
    }
    return unitePeople(answers, { self: this._state.profile.id, onBad: (source, pid) => this._badCard(source, pid) })
  }

  // A person as the page sees them.
  _person (id, e, tag) {
    const me = this._state.profile.id
    return {
      id,
      pid: profileIdText(id),
      name: e.card.name,
      tag: tag || null,
      photo: e.card.photo,
      seen: e.seen,
      blocked: this._state.social.blocked.ids.includes(id),
      chat: id === me ? null : directId(me, id),
      sources: e.sources.slice(),
      now: e.now,
      last: e.last
    }
  }

  // The tags of everyone in the union (and of extra, a person of a page), you
  // among them.
  _tags (union, extra = null) {
    const p = this._state.profile
    const all = [{ id: p.id, name: p.name }]
    for (const [id, e] of union) if (id !== p.id) all.push({ id, name: e.card.name })
    if (extra !== null && extra.id !== p.id && !union.has(extra.id)) all.push(extra)
    return nameTags(all)
  }

  // GET /local/people: you and the union of the people of every social source.
  async _getPeople () {
    const p = this._state.profile
    let me = null
    let people = []
    const supported = this._supported()
    if (p !== null) {
      if (supported) await this._refreshPeople()
      const union = supported && this._state.profile !== null && this._state.profile.id === p.id ? this._union() : new Map()
      const tags = this._tags(union)
      people = [...union].map(([id, e]) => this._person(id, e, tags.get(id))).sort(byName)
      me = { id: p.id, pid: profileIdText(p.id), name: p.name, photo: p.photo, tag: tags.get(p.id) || null }
    }
    const v = sha256Hex(b4a.from(JSON.stringify([supported, me, people]), 'utf8')).slice(0, 16)
    return [200, { supported, v, me, people }]
  }

  // The page of one person on one source: { rt, status: 200 | 404 | 'failed', ... }.
  _askPage (rt, id) {
    return rt.link.request('GET', '/api/people/' + id, { headers: this._proofHeaders(rt) || {}, timeout: PEOPLE_TIMEOUT_MS }).then((res) => {
      const at = Date.now()
      if (res.status === 404) return { rt, status: 404 }
      const data = res.status === 200 ? parseJsonOrNull(res.body) : null
      if (data === null || !Number.isSafeInteger(data.time) || data.person === null || typeof data.person !== 'object' || data.person.profileId !== id) {
        return { rt, status: 'failed' }
      }
      return { rt, status: 200, offset: at - data.time, person: data.person, recent: data.recent }
    }, () => ({ rt, status: 'failed' }))
  }

  /**
   * GET /local/people/<id>: the person and their recent plays from the pages of
   * every connected social source. Your own id: as the others see you, hidden
   * (and without activity) when no source shows you.
   */
  async _getPerson (id) {
    const profile = this._state.profile
    if (profile === null) throw localError('no_profile')
    if (!HEX32_RE.test(id)) throw new HttpError(404, 'Persona non trovata', 'not_found')
    // The pages and the lists at the same time: the page asks for an answer within 8 s.
    const asks = this._socialRuntimes().filter((rt) => rt.link.status.connected).map((rt) => this._askPage(rt, id))
    const [results] = await Promise.all([settledWithin(asks, PAGE_WAIT_MS), this._supported() ? this._refreshPeople() : null])
    if (this._state.profile === null || this._state.profile.id !== profile.id) throw localError('no_profile')
    const mine = id === profile.id
    const pages = results.filter((r) => r.status === 200)
    const found = unitePeople(pages.map((r) => ({ source: r.rt.id, offset: r.offset, people: [r.person] })), {
      self: mine ? null : profile.id,
      onBad: (source, pid) => this._badCard(source, pid)
    }).get(id)
    const union = this._supported() ? this._union() : new Map()
    const listed = union.get(id)
    if (found !== undefined) {
      const tags = this._tags(union, { id, name: found.card.name })
      if (listed !== undefined) for (const sid of listed.sources) if (!found.sources.includes(sid)) found.sources.push(sid)
      const person = this._person(id, found, tags.get(id))
      if (mine) person.hidden = false
      const recent = uniteRecent(pages.filter((r) => found.sources.includes(r.rt.id)).map((r) => ({ offset: r.offset, recent: r.recent })))
      return [200, { person, recent }]
    }
    if (mine) {
      const tags = this._tags(union)
      const p = this._state.profile
      const person = {
        id, pid: profileIdText(id), name: p.name, tag: tags.get(id) || null, photo: p.photo, seen: 'all', blocked: false, chat: null, sources: [], now: null, last: null, hidden: true
      }
      return [200, { person, recent: [] }]
    }
    // No page came, but the list holds the person and one of their sources did
    // not say no: the list's view, without the recent plays.
    const said404 = new Set(results.filter((r) => r.status === 404).map((r) => r.rt.id))
    if (listed !== undefined && listed.sources.some((sid) => !said404.has(sid))) {
      const tags = this._tags(union)
      return [200, { person: this._person(id, listed, tags.get(id)), recent: [] }]
    }
    throw new HttpError(404, 'Persona non trovata', 'not_found')
  }

  /**
   * GET /local/people/<id>/photo?v=<hash>: the photo of a person's card, read from
   * a source of theirs and kept only when its bytes hash to the card's photo (the
   * next source is tried otherwise). With v the URL names the bytes for good.
   */
  async _personPhoto (req, id) {
    const profile = this._state.profile
    if (profile === null) throw localError('no_profile')
    if (!HEX32_RE.test(id)) throw localError('no_photo')
    const v = queryParam(req.query, 'v')
    let hash = null
    let sources = []
    if (id === profile.id) {
      hash = profile.photo
    } else {
      let e = this._supported() ? this._union().get(id) : undefined
      if (e === undefined && this._supported()) {
        await this._refreshPeople()
        if (this._state.profile !== null && this._state.profile.id === profile.id) e = this._union().get(id)
      }
      if (e !== undefined) {
        hash = e.card.photo
        sources = e.sources
      }
    }
    if (hash === null || (v !== null && v !== hash)) throw localError('no_photo')
    const etag = '"' + hash + '"'
    const headers = { 'Content-Type': 'image/jpeg', 'Cache-Control': v !== null ? IMMUTABLE : 'no-cache', ETag: etag }
    if (etagMatches(req.map['if-none-match'], etag)) return { status: 304, headers, body: null }
    const bytes = id === profile.id ? readPhoto(this._statePath, hash) : await this._fetchPhoto(id, hash, sources)
    if (bytes === null) throw localError('no_photo')
    return { status: 200, headers: { ...headers, 'Content-Length': bytes.byteLength }, body: bytes }
  }

  _fetchPhoto (id, hash, sources) {
    const hit = this._photos.get(hash)
    if (hit !== null) return Promise.resolve(hit)
    let run = this._photoFetches.get(hash)
    if (run !== undefined) return run
    run = (async () => {
      for (const sid of sources) {
        const rt = this._sources.get(sid)
        if (rt === undefined || !this._live(rt) || !rt.link.status.connected) continue
        try {
          const res = await rt.link.request('GET', '/api/people/' + id + '/photo', { headers: this._proofHeaders(rt) || {}, timeout: PEOPLE_TIMEOUT_MS })
          if (res.status === 200 && validPhoto(res.body) && photoHash(res.body) === hash) {
            const bytes = b4a.from(res.body)
            this._photos.set(hash, bytes)
            return bytes
          }
          this._log('photo of ' + id + ' from ' + sid + ' not taken (' + (res.status !== 200 ? res.status : 'not the photo of the card') + ')')
        } catch (err) {
          this._log('photo of ' + id + ' from ' + sid + ' not read (' + ((err && (err.detail || err.code || err.message)) || err) + ')')
        }
      }
      return null
    })().finally(() => this._photoFetches.delete(hash))
    this._photoFetches.set(hash, run)
    return run
  }

  // -------------------------------------------------- recovery by password

  // POST /local/recovery { code }: this device joins a source as a guest, with a
  // link of its own, and reads who can be recovered there.
  async _startRecovery (body) {
    if (this._state.profile !== null) throw localError('profile_exists')
    const code = typeof body.code === 'string' ? body.code : ''
    if (codeKind(code) === 'profile') throw localError('profile_code')
    try {
      parseCode(code)
    } catch {
      throw localError('bad_code')
    }
    // One session at a time: the one before goes first, admission included.
    await this._endSessions()
    const res = await this._pair(code)
    const key = String(res.serverPublicKey).toLowerCase()
    const rt = [...this._sources.values()].find((x) => x.serverPublicKey === key)
    const session = {
      id: b4a.toString(randomBytes(8), 'hex'),
      serverPublicKey: key,
      clientKey: this._keyPair.publicKey, // the key the source admitted
      link: rt !== undefined ? rt.link : new MPfyLink({ serverPublicKey: key, keyPair: this._keyPair, dht: this._dht }),
      ownLink: rt === undefined,
      timer: null,
      chain: Promise.resolve(),
      closed: false
    }
    if (session.ownLink) session.link.start()
    else session.link.refresh()
    this._sessions.set(session.id, session)
    this._touchSession(session)
    let list
    let info
    try {
      [list, info] = await Promise.all([
        this._sessionAsk(session, 'GET', '/api/recovery/profiles'),
        this._sessionAsk(session, 'GET', '/api/profile').catch(() => null)
      ])
    } catch (err) {
      await this._closeSession(session, { forget: true })
      throw err
    }
    if (list.status !== 200 && list.status !== 404) {
      await this._closeSession(session, { forget: true })
      this._log('recovery: profiles not read (' + list.status + ')')
      throw localError('failed')
    }
    const entries = []
    const raw = list.status === 200 && list.data !== null && Array.isArray(list.data.entries) ? list.data.entries : []
    for (const e of raw) {
      if (e === null || typeof e !== 'object' || !HEX32_RE.test(e.profileId) || !HEX64_RE.test(e.device)) continue
      entries.push({ profileId: e.profileId, name: typeof e.name === 'string' ? e.name : '', device: e.device, deviceName: typeof e.deviceName === 'string' ? e.deviceName : '' })
    }
    const named = info !== null && info.status === 200 && profileAnswer(info.data) ? cleanName(info.data.source.name) : ''
    return [200, { sessionId: session.id, source: { name: named || cleanName(res.name) || 'Fonte' }, entries }]
  }

  _touchSession (session) {
    clearTimeout(session.timer)
    session.timer = setTimeout(() => {
      this._log('recovery session expired')
      this._closeSession(session, { forget: true })
    }, this._recoverySessionMs)
  }

  /**
   * End a recovery session. forget: ask the source to forget this device first,
   * unless this device still uses that admission: the source is among its sources
   * now (it may have been added while the session was open) and its key is the
   * one the session was admitted with.
   */
  async _closeSession (session, { forget }) {
    if (session.closed) return
    session.closed = true
    clearTimeout(session.timer)
    this._sessions.delete(session.id)
    const kept = this._keyPair !== null && this._keyPair.publicKey === session.clientKey &&
      this._state.sources.some((s) => s.serverPublicKey === session.serverPublicKey)
    if (forget && !kept) await this._forgetMe(session.link)
    if (session.ownLink) await session.link.close().catch(noop)
  }

  // Every open recovery session ends as if cancelled: at stop, before another one,
  // and once there is a profile (a recovery can no longer finish then).
  _endSessions () {
    return Promise.all([...this._sessions.values()].map((s) => this._closeSession(s, { forget: true })))
  }

  async _sessionAsk (session, method, path, body = null) {
    let res
    try {
      res = await session.link.request(method, path, { body, timeout: this._recoveryRequestMs })
    } catch {
      throw localError('unreachable')
    }
    return { status: res.status, data: parseJsonOrNull(res.body) }
  }

  // POST /local/recovery/<session> { profileId, device, password }.
  async _finishRecovery (sessionId, body) {
    const session = this._sessions.get(sessionId)
    if (session === undefined) throw localError('session_gone')
    if (this._state.profile !== null) throw localError('profile_exists')
    const { profileId, device, password } = body
    if (typeof profileId !== 'string' || !HEX32_RE.test(profileId) || typeof device !== 'string' || !HEX64_RE.test(device) || typeof password !== 'string') {
      throw localError('bad_request')
    }
    this._touchSession(session)
    const run = session.chain.then(() => this._tryRecovery(session, profileId, device, password))
    session.chain = run.then(noop, noop)
    return run
  }

  async _tryRecovery (session, profileId, device, password) {
    if (session.closed) throw localError('session_gone')
    const base = '/api/recovery/' + profileId + '/' + device
    const params = await this._sessionAsk(session, 'GET', base)
    if (params.status !== 200) throw sourceError(params)
    const p = params.data
    // Only the parameters this core knows: anything else never reaches Argon2id.
    if (p === null || p.opslimit !== OPSLIMIT || p.memlimit !== MEMLIMIT || typeof p.salt !== 'string' || !HEX32_RE.test(p.salt)) {
      throw localError('no_recovery')
    }
    const keys = await deriveRecoveryKeys(password, b4a.from(p.salt, 'hex'))
    if (session.closed) throw localError('session_gone')
    const released = await this._sessionAsk(session, 'POST', base + '/release', { verifier: b4a.toString(keys.verifierKey, 'hex') })
    if (released.status !== 200) throw sourceError(released)
    const text = released.data !== null ? decryptBlob(released.data.blob, keys.encKey, profileId) : null
    const identity = text === null ? null : parseIdentity(text)
    if (identity === null || identity.profile.id !== profileId) {
      this._log('recovery: the blob did not open or did not hold a valid identity')
      throw localError('failed')
    }
    const recovery = {
      salt: p.salt,
      opslimit: OPSLIMIT,
      memlimit: MEMLIMIT,
      encKey: b4a.toString(keys.encKey, 'hex'),
      verifierHash: b4a.toString(keys.verifierHash, 'hex'),
      updatedAt: sourceTime(released.data.updatedAt) !== null ? released.data.updatedAt : Date.now()
    }
    return this._identityOp(async () => {
      if (session.closed) throw localError('session_gone')
      if (this._state.profile !== null) throw localError('profile_exists')
      // The key this device used until now goes everywhere, the code's source
      // included even when it was among the sources: left there it would be a key
      // nobody holds.
      const changing = identity.clientSeed !== this._state.clientSeed
      if (changing) await this._forgetMe(session.link)
      await this._closeSession(session, { forget: false })
      return this._adoptIdentity(identity, recovery, changing ? session.serverPublicKey : null)
    })
  }

  async _cancelRecovery (sessionId) {
    const session = this._sessions.get(sessionId)
    if (session !== undefined) await this._closeSession(session, { forget: true })
    return [200, { ok: true }]
  }

  // ------------------------------------------------------------ HTTP

  _onConnection (socket) {
    socket.on('error', noop)
    if (this._stopping || this._sockets.size >= MAX_CONNECTIONS) {
      socket.destroy()
      return
    }
    const conn = { socket, closed: false, responded: false, forwarded: false, isHead: false, local: false, timer: null, timer2: null }
    this._sockets.add(socket)
    socket.on('close', () => {
      conn.closed = true
      this._sockets.delete(socket)
      clearTimeout(conn.timer)
      clearTimeout(conn.timer2)
    })
    this._readHead(conn)
  }

  _readHead (conn) {
    const socket = conn.socket
    let buf = EMPTY
    let done = false
    const finish = () => {
      done = true
      clearTimeout(conn.timer)
      conn.timer = null
      socket.pause()
      socket.off('data', ondata)
      socket.off('end', onend)
    }
    const ondata = (chunk) => {
      if (done) return
      const from = Math.max(0, buf.byteLength - 3)
      buf = buf.byteLength === 0 ? chunk : b4a.concat([buf, chunk])
      const { start, end } = findHeadEnd(buf, from)
      if (end === -1) {
        if (buf.byteLength > MAX_HEAD_BYTES) {
          finish()
          this._fail(conn, new HttpError(431, 'Richiesta troppo grande'))
        }
        return
      }
      finish()
      let req
      try {
        req = parseRequestHead(buf, start, end)
      } catch (err) {
        this._fail(conn, err)
        return
      }
      conn.isHead = req.method === 'HEAD'
      this._handle(conn, req, buf.subarray(end)).catch((err) => this._fail(conn, err))
    }
    // Closed (or half-closed) before a complete head: nothing to answer.
    const onend = () => {
      if (done) return
      finish()
      socket.destroy()
    }
    conn.timer = setTimeout(() => {
      if (done) return
      finish()
      socket.destroy()
    }, this._headTimeoutMs)
    socket.on('data', ondata)
    socket.on('end', onend)
  }

  /**
   * How a request names the core: 'own' (127.0.0.1:<port>, or no Host at all:
   * HTTP/1.0, since an HTTP/1.1 head without Host does not parse), 'alias'
   * (localhost or [::1] with our port: this core, but another origin for a
   * browser), or null (any other name).
   */
  _hostKind (host) {
    if (host === undefined) return 'own'
    const h = host.toLowerCase()
    const port = ':' + this._boundPort
    if (h === '127.0.0.1' + port) return 'own'
    if (h === 'localhost' + port || h === '[::1]' + port) return 'alias'
    return null
  }

  async _handle (conn, req, rest) {
    // A page on another site pointing its own name at 127.0.0.1 (DNS rebinding)
    // would be same-origin and send no Origin: the Host tells it apart.
    const hostKind = this._hostKind(req.map.host)
    if (hostKind === null) throw new HttpError(403, 'Richiesta rifiutata')
    // CSRF guard: no Origin, or exactly ours, for anything but GET/HEAD, and for
    // every /local/* request.
    const safe = req.method === 'GET' || req.method === 'HEAD'
    const isLocal = req.path === '/local' || req.path.startsWith('/local/')
    const origin = req.map.origin
    if (origin !== undefined && origin !== this._origin && (!safe || isLocal)) throw new HttpError(403, 'Richiesta rifiutata')
    // The UI has one origin, http://127.0.0.1:<port>: the guard above (and the
    // WebView's storage) know no other. Opened as http://localhost:<port>/ it would
    // load and then see every change refused, so any request by an alias is sent
    // to the same target on the one origin (308 keeps the method and the body).
    if (hostKind === 'alias') return this._redirect(conn, this._origin + req.target)
    // Any app on the phone can open 127.0.0.1: the sources and the pairing code are
    // only for the one that knows the token. The UI files are public anyway.
    if (this._token !== null && (isLocal || req.path.startsWith('/s/')) && !this._hasToken(req)) {
      throw new HttpError(403, 'Richiesta rifiutata')
    }
    // Past the guards, the /local endpoints answer their errors with a code.
    conn.local = isLocal

    const fwd = splitSourceTarget(req)
    if (fwd !== null) return this._forward(conn, req, fwd, rest)
    // The app's own files (a picked folder) live inside its WebView, never here.
    if (req.path === '/__native' || req.path.startsWith('/__native/')) throw new HttpError(404, 'Risorsa non trovata')

    // The whole set of the phone's songs a real source holds is the one bigger body.
    const body = await this._readBody(conn, req, rest, req.path === '/local/phone/shadowed' ? MAX_SHADOWED * 28 + 1024 : MAX_LOCAL_BODY)
    if (body === null) {
      conn.socket.destroy() // the client went away before its body was complete
      return
    }
    if (isLocal) return this._local(conn, req, body)
    return this._serveStatic(conn, req)
  }

  _hasToken (req) {
    const header = req.map['x-mpfy-token']
    if (header !== undefined && sameBytes(b4a.from(header, 'latin1'), this._token)) return true
    const cookie = req.map.cookie
    if (cookie === undefined) return false
    for (const part of cookie.split(/[;,]/)) {
      const eq = part.indexOf('=')
      if (eq === -1 || part.slice(0, eq).trim() !== 'mpfy_token') continue
      if (sameBytes(b4a.from(part.slice(eq + 1).trim(), 'latin1'), this._token)) return true
    }
    return false
  }

  // /s/<id>/<rest>: a channel to the source (waiting up to 6 s for a link that is
  // down), the rewritten head, then the body and the response piped raw.
  async _forward (conn, req, fwd, rest) {
    // The phone's own music is answered here, never forwarded.
    if (fwd.id === PHONE_ID && this._phone !== null) return this._phone.handle(conn, req, fwd.target, rest)
    const rt = this._sources.get(fwd.id)
    if (rt === undefined || rt.removing !== null) throw new HttpError(404, 'Fonte sconosciuta')
    // The page's profile headers never pass; the core's own go with every request.
    const head = buildForwardHead(req, fwd.target, this._proofHeaders(rt))
    let stream
    try {
      stream = await rt.link.openStream({ timeout: this._offlineWaitMs })
    } catch {
      if (conn.closed) return
      if (this._sources.get(fwd.id) !== rt || rt.removing !== null) throw new HttpError(404, 'Fonte sconosciuta')
      throw new HttpError(503, 'Fonte non raggiungibile')
    }
    if (conn.closed || this._stopping) {
      stream.destroy()
      conn.socket.destroy()
      return
    }
    conn.forwarded = true
    // Only streams measure the link (meter.js): small answers measure latency.
    const metered = req.method === 'GET' && fwd.target.startsWith('/api/stream/')
    pipeForward({ socket: conn.socket, stream, head, rest, req, flow: metered ? rt.meter.flow() : null })
  }

  /** The body of a request the core answers itself (at most 64 KB). null: the client left. */
  _readBody (conn, req, rest, max = MAX_LOCAL_BODY) {
    if (req.body === 'none') return Promise.resolve(EMPTY)
    if (req.body === 'length' && req.contentLength > max) return Promise.reject(new HttpError(413, 'Richiesta troppo grande'))
    if (conn.closed) return Promise.resolve(null)
    const socket = conn.socket
    return new Promise((resolve, reject) => {
      const decoder = req.body === 'chunked' ? new ChunkedDecoder({ maxBytes: max }) : null
      const parts = []
      let got = 0
      let settled = false
      const settle = (err, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.off('data', ondata)
        socket.off('end', onend)
        socket.off('close', onend)
        socket.pause()
        if (err) reject(err)
        else resolve(value)
      }
      const feed = (chunk) => {
        try {
          if (decoder !== null) {
            if (decoder.push(chunk) !== -1) settle(null, decoder.body)
            return
          }
          const need = req.contentLength - got
          const piece = chunk.byteLength > need ? chunk.subarray(0, need) : chunk
          parts.push(piece)
          got += piece.byteLength
          if (got === req.contentLength) settle(null, b4a.concat(parts))
        } catch (err) {
          settle(err)
        }
      }
      const ondata = (chunk) => feed(chunk)
      const onend = () => settle(null, null)
      const timer = setTimeout(() => settle(new HttpError(408, 'Richiesta scaduta')), BODY_TIMEOUT_MS)
      if (rest.byteLength > 0) feed(rest)
      if (settled) return
      if (req.expectContinue) socket.write(b4a.from('HTTP/1.1 100 Continue\r\n\r\n', 'latin1'))
      socket.on('data', ondata)
      socket.on('end', onend)
      socket.on('close', onend)
      socket.resume()
    })
  }

  async _local (conn, req, body) {
    const answer = await this._localRoute(req, body)
    // Bytes (the photo) come as { status, headers, body }, everything else as JSON.
    if (!Array.isArray(answer)) return this._send(conn, answer.status, answer.headers, answer.body)
    const [status, data] = answer
    // A list the page already holds (its v sent back as If-None-Match): nothing to
    // send, nothing for the page to read again.
    if (status === 200 && data !== null && typeof data === 'object' && typeof data.v === 'string' && req.map['if-none-match'] === '"' + data.v + '"') {
      return this._send(conn, 304, { 'Cache-Control': 'no-store' }, null)
    }
    return this._json(conn, status, data)
  }

  _localRoute (req, body) {
    const method = req.method
    const read = method === 'GET' || method === 'HEAD'
    const p = req.path
    switch (p) {
      case '/local/sources':
        if (read) return [200, this._phone !== null ? { sources: this._list(), phone: this._phone.entry() } : { sources: this._list() }]
        if (method === 'POST') return this._addSource(parseJsonObject(body))
        throw methodNotAllowed('GET, HEAD, POST')
      case '/local/phone/shadowed':
        if (this._phone === null) throw new HttpError(404, 'Risorsa non trovata')
        if (method === 'PUT') {
          return this._phone.shadowed(parseJsonObject(body)).then((r) => [200, r], (err) => {
            if (err && err.badRequest) throw localError('bad_request')
            throw err
          })
        }
        throw methodNotAllowed('PUT')
      case '/local/phone/moved':
        if (this._phone === null || this._phonePerson === null) throw new HttpError(404, 'Risorsa non trovata')
        if (method === 'POST') return this._phoneMoved(parseJsonObject(body))
        throw methodNotAllowed('POST')
      case '/local/profile':
        if (read) return this._getProfile()
        if (method === 'POST') return this._createProfile(parseJsonObject(body))
        if (method === 'PATCH') return this._renameProfile(parseJsonObject(body))
        throw methodNotAllowed('GET, HEAD, POST, PATCH')
      case '/local/profile/code':
        if (read) return this._profileCode()
        throw methodNotAllowed('GET, HEAD')
      case '/local/profile/photo':
        if (read) return this._photoAnswer(req)
        if (method === 'PUT') return this._putPhoto(req, body)
        if (method === 'DELETE') return this._deletePhoto()
        throw methodNotAllowed('GET, HEAD, PUT, DELETE')
      case '/local/profile/export':
        if (read) return this._export()
        throw methodNotAllowed('GET, HEAD')
      case '/local/profile/import':
        if (method === 'POST') return this._import(parseJsonObject(body))
        throw methodNotAllowed('POST')
      case '/local/profile/recovery':
        if (method === 'PUT') return this._enableRecovery(parseJsonObject(body))
        if (method === 'DELETE') return this._disableRecovery()
        throw methodNotAllowed('PUT, DELETE')
      case '/local/sync':
        if (method === 'POST') return this._syncAll()
        throw methodNotAllowed('POST')
      case '/local/recovery':
        if (method === 'POST') return this._startRecovery(parseJsonObject(body))
        throw methodNotAllowed('POST')
      case '/local/people':
        if (read) return this._getPeople()
        throw methodNotAllowed('GET, HEAD')
      case '/local/social':
        if (read) return this._getSocial()
        if (method === 'PATCH') return this._patchSocial(parseJsonObject(body))
        throw methodNotAllowed('GET, HEAD, PATCH')
      case '/local/activity':
        if (method === 'PUT') return this._putActivity(parseJsonObject(body))
        throw methodNotAllowed('PUT')
      case '/local/social/blocked':
        if (method === 'POST') {
          const b = parseJsonObject(body)
          if (Object.keys(b).some((k) => k !== 'profileId')) throw localError('bad_request')
          return this._block(b.profileId, true)
        }
        throw methodNotAllowed('POST')
      case '/local/chat/conversations':
        if (read) return this._chatsOrNoProfile().conversations()
        throw methodNotAllowed('GET, HEAD')
      case '/local/chat/shared':
        if (read) return this._chatsOrNoProfile().shared()
        throw methodNotAllowed('GET, HEAD')
    }
    let m = /^\/local\/recovery\/([^/]+)$/.exec(p)
    if (m !== null) {
      if (method === 'POST') return this._finishRecovery(m[1], parseJsonObject(body))
      if (method === 'DELETE') return this._cancelRecovery(m[1])
      throw methodNotAllowed('POST, DELETE')
    }
    m = /^\/local\/people\/([^/]+)(\/photo)?$/.exec(p)
    if (m !== null) {
      if (!read) throw methodNotAllowed('GET, HEAD')
      let id = ''
      try {
        id = decodeURIComponent(m[1]).toLowerCase()
      } catch {}
      return m[2] !== undefined ? this._personPhoto(req, id) : this._getPerson(id)
    }
    m = /^\/local\/social\/blocked\/([^/]+)$/.exec(p)
    if (m !== null) {
      if (method === 'DELETE') return this._block(decodeId(m[1]), false)
      throw methodNotAllowed('DELETE')
    }
    m = /^\/local\/chat\/([^/]+)\/(messages|read|mute)(?:\/([^/]+)(\/playlist)?)?$/.exec(p)
    if (m !== null) {
      const cid = decodeId(m[1])
      const what = m[2]
      const chats = this._chatsOrNoProfile()
      if (what === 'messages' && m[3] === undefined) {
        if (read) return chats.messages(cid, { limit: queryParam(req.query, 'limit'), before: queryParam(req.query, 'before') })
        if (method === 'POST') return chats.send(cid, parseJsonObject(body))
        throw methodNotAllowed('GET, HEAD, POST')
      }
      if (what === 'messages' && m[4] === undefined) {
        if (method === 'DELETE') return chats.remove(cid, decodeId(m[3]))
        throw methodNotAllowed('DELETE')
      }
      if (what === 'messages') {
        if (read) return chats.playlist(cid, decodeId(m[3]))
        throw methodNotAllowed('GET, HEAD')
      }
      if (m[3] !== undefined) throw new HttpError(404, 'Risorsa non trovata')
      if (what === 'read') {
        if (method === 'PUT') return chats.read(cid, parseJsonObject(body))
        throw methodNotAllowed('PUT')
      }
      if (method === 'PUT') return this._mute(cid, parseJsonObject(body))
      throw methodNotAllowed('PUT')
    }
    m = /^\/local\/sources\/([^/]+)$/.exec(p)
    if (m === null) throw new HttpError(404, 'Risorsa non trovata')
    let id = ''
    try {
      id = decodeURIComponent(m[1]).toLowerCase()
    } catch {}
    const entry = this._state.sources.find((s) => s.id === id)
    if (entry === undefined) throw new HttpError(404, 'Fonte sconosciuta')
    if (read) return [200, { source: this._entry(entry) }]
    if (method === 'PATCH') return this._patchSource(id, parseJsonObject(body))
    if (method === 'DELETE') return this._removeSource(id)
    throw methodNotAllowed('GET, HEAD, PATCH, DELETE')
  }

  /**
   * POST /local/phone/moved { to, uv, ue }: the page copied the phone store's data to the
   * principal `to` from its state at (uv, ue). When the store is still there, its log is
   * kept aside and it is empty: the home is the principal from now on. 409 `changed`: a
   * change reached the store meanwhile (the page copies again); 404 `not_found`: `to` is
   * not the principal.
   */
  async _phoneMoved (b) {
    const keys = Object.keys(b)
    if (keys.some((k) => k !== 'to' && k !== 'uv' && k !== 'ue') || typeof b.to !== 'string' || !/^[0-9a-f]{8}$/.test(b.to) ||
      !Number.isSafeInteger(b.uv) || b.uv < 0 || typeof b.ue !== 'string' || !/^[0-9a-f]{16}$/.test(b.ue)) throw localError('bad_request')
    const isPrincipal = () => this._state.sources.some((s) => s.principal && s.id === b.to)
    if (!isPrincipal()) throw new HttpError(404, 'Fonte sconosciuta', 'not_found')
    const done = await this._phonePerson.moved(b.uv, b.ue, isPrincipal)
    if (done === null) throw new HttpError(404, 'Fonte sconosciuta', 'not_found')
    if (!done) throw localError('changed')
    this._homeMayHaveMoved()
    return [200, { ok: true }]
  }

  // The chats, once there is a profile.
  _chatsOrNoProfile () {
    if (this._state.profile === null) throw localError('no_profile')
    return this._chats
  }

  async _serveStatic (conn, req) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw methodNotAllowed('GET, HEAD')
    const found = await this._static.resolve(req.path)
    if (found === null) throw new HttpError(404, 'Risorsa non trovata')
    const etag = etagOf(found.stat)
    const headers = { 'Content-Type': mimeType(found.file), 'Cache-Control': 'no-cache', ETag: etag }
    if (etagMatches(req.map['if-none-match'], etag)) return this._send(conn, 304, headers, null)
    if (found.stat.size > MAX_STATIC_BYTES) throw new Error('static file too large: ' + found.file)
    if (conn.isHead) return this._send(conn, 200, { ...headers, 'Content-Length': found.stat.size }, null)
    const data = await this._static.read(found.file)
    return this._send(conn, 200, { ...headers, 'Content-Length': data.byteLength }, data)
  }

  _redirect (conn, location) {
    this._send(conn, 308, { Location: location, 'Cache-Control': 'no-store', 'Content-Length': 0 }, null)
  }

  _json (conn, status, obj, extra = null) {
    const body = b4a.from(JSON.stringify(obj), 'utf8')
    this._send(conn, status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': body.byteLength,
      ...extra
    }, body)
  }

  _fail (conn, err) {
    if (conn.forwarded) {
      conn.socket.destroy()
      return
    }
    const known = err instanceof HttpError
    if (!known) this._log('request failed: ' + ((err && err.stack) || err))
    const status = known ? err.status : 500
    const body = { error: known ? err.message : 'Qualcosa non ha funzionato' }
    // The /local endpoints say what went wrong with a code the page maps to its words.
    if (conn.local) {
      body.code = (known && err.code) || STATUS_CODES[status] || 'failed'
      if (known && err.extra !== null) Object.assign(body, err.extra)
    }
    this._json(conn, status, body, known && err.headers ? err.headers : null)
  }

  _send (conn, status, headers, body) {
    if (conn.closed || conn.responded) return
    conn.responded = true
    const socket = conn.socket
    socket.write(responseHead(status, {
      'Content-Security-Policy': CSP,
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...headers,
      Connection: 'close'
    }))
    if (body !== null && body.byteLength > 0 && !conn.isHead) socket.write(body)
    this._linger(conn)
  }

  /**
   * An answer written in pieces (an iterable of strings) with chunked framing,
   * waiting for the socket to drain between pieces: a long answer never sits whole
   * in memory, and a slow reader holds the writer back. HEAD: the head alone.
   */
  async _sendPieces (conn, status, headers, pieces) {
    if (conn.isHead) return this._send(conn, status, headers, null)
    if (conn.closed || conn.responded) return
    conn.responded = true
    const socket = conn.socket
    socket.write(responseHead(status, {
      'Content-Security-Policy': CSP,
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...headers,
      'Transfer-Encoding': 'chunked',
      Connection: 'close'
    }))
    for (const piece of pieces) {
      if (conn.closed) return
      if (piece === '') continue
      const data = b4a.from(piece, 'utf8')
      if (!socket.write(b4a.concat([b4a.from(data.byteLength.toString(16) + '\r\n', 'latin1'), data, CRLF]))) await drained(conn)
    }
    if (conn.closed) return
    socket.write(LAST_CHUNK)
    this._linger(conn)
  }

  // The answer is out: read and drop whatever the client still sends (an upload
  // refused before its body), so it sees the answer instead of a reset; close for
  // good a moment after the answer is out, or after LINGER_MAX_MS whatever happens.
  _linger (conn) {
    const socket = conn.socket
    socket.end()
    socket.on('data', noop)
    socket.resume()
    clearTimeout(conn.timer)
    conn.timer = setTimeout(() => socket.destroy(), LINGER_MAX_MS)
    socket.once('finish', () => {
      clearTimeout(conn.timer2)
      conn.timer2 = setTimeout(() => socket.destroy(), LINGER_MS)
    })
  }
}

const CRLF = b4a.from('\r\n', 'latin1')
const LAST_CHUNK = b4a.from('0\r\n\r\n', 'latin1')

// The socket of a connection drained, or closed.
function drained (conn) {
  return new Promise((resolve) => {
    const socket = conn.socket
    const done = () => {
      socket.off('drain', done)
      socket.off('close', done)
      resolve()
    }
    socket.on('drain', done)
    socket.on('close', done)
  })
}

function methodNotAllowed (allow) {
  const err = new HttpError(405, 'Metodo non consentito')
  err.headers = { Allow: allow }
  return err
}

// The body of PUT /local/profile/photo: image/jpeg and nothing else.
function isJpegType (value) {
  return typeof value === 'string' && value.split(';')[0].trim().toLowerCase() === 'image/jpeg'
}

function parseJsonObject (body) {
  if (body.byteLength === 0) return {}
  let value
  try {
    value = JSON.parse(b4a.toString(body, 'utf8'))
  } catch {
    throw new HttpError(400, 'Richiesta non valida')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Richiesta non valida')
  return value
}

/**
 * A link error in a few words for the settings line ("Non raggiungibile: ...").
 * Never a code; null when there is nothing to say.
 */
export function linkErrorWords (code) {
  if (code === null || code === undefined) return null
  if (code === 'PEER_NOT_FOUND') return 'spenta o senza rete'
  if (code === 'CONNECTION_CLOSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'CHANNEL_CLOSED') return 'collegamento interrotto'
  return 'collegamento non riuscito'
}

// Constant time for equal lengths; the length of the token is not a secret.
function sameBytes (a, b) {
  if (a.byteLength !== b.byteLength) return false
  let diff = 0
  for (let i = 0; i < a.byteLength; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

// ------------------------------------------------------------------ helpers

function deferred () {
  let resolve = null
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

// Wait for `promise`, at most `ms`; never rejects.
function withTimeout (promise, ms) {
  let timer = null
  return Promise.race([
    Promise.resolve(promise).then(noop, noop),
    new Promise((resolve) => { timer = setTimeout(resolve, ms) })
  ]).then(() => clearTimeout(timer))
}

function parseJsonOrNull (bytes) {
  try {
    const value = JSON.parse(b4a.toString(bytes, 'utf8'))
    return value !== null && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

/**
 * A time a source gives back, when it could be real: whole milliseconds, at most
 * 5 minutes ahead (the bound the sources apply to names). Else null. A source
 * run by someone else must not push this device's times out of reach.
 */
function sourceTime (t) {
  return Number.isSafeInteger(t) && t >= 0 && t <= Date.now() + SOURCE_FUTURE_MS ? t : null
}

// The social part a source speaks, from GET /api/profile: 0 when it says nothing.
function socialLevel (p) {
  const v = p.social !== null && typeof p.social === 'object' ? p.social.v : undefined
  return Number.isSafeInteger(v) && v >= 0 ? v : 0
}

// A section of the settings a source gave, as the state keeps it; null when it
// is not valid (or, for the mutes, when its box does not open with this
// profile's key).
function sectionIn (k, v, keys, self) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null
  const updatedAt = sourceTime(v.updatedAt)
  if (updatedAt === null) return null
  if (k === 'privacy') {
    if (typeof v.invisible !== 'boolean' || typeof v.showNow !== 'boolean' || typeof v.showRecent !== 'boolean') return null
    if (!Number.isSafeInteger(v.privateUntil) || v.privateUntil < 0) return null
    return { invisible: v.invisible, showNow: v.showNow, privateUntil: v.privateUntil, showRecent: v.showRecent, updatedAt }
  }
  if (k === 'blocked') {
    if (!Array.isArray(v.ids)) return null
    const ids = [...new Set(v.ids.filter((id) => typeof id === 'string' && HEX32_RE.test(id) && id !== self))]
    return { ids, updatedAt }
  }
  const map = v.box === null ? {} : openMutes(v.box, keys.socialKey)
  return map === null ? null : { map, updatedAt }
}

// A text of a reported track: one line, at most 200 code points.
function trackText (v, required) {
  if (v === undefined || v === null) {
    if (required) throw localError('bad_request')
    return ''
  }
  if (typeof v !== 'string') throw localError('bad_request')
  const s = Array.from(v.replace(LINE_BREAKS_RE, ' ').replace(/\s+/g, ' ').trim()).slice(0, MAX_TRACK_TEXT).join('').trim()
  if (required && s === '') throw localError('bad_request')
  return s
}

// The body of PUT /local/activity: { track: null or { trackId, title, artist?,
// album?, artistPage? }, playing }, nothing else. Throws bad_request.
function activityIn (body) {
  if (typeof body.playing !== 'boolean' || Object.keys(body).some((k) => !ACTIVITY_KEYS.includes(k))) throw localError('bad_request')
  const t = body.track
  if (t === null || t === undefined) return { track: null, playing: body.playing }
  if (typeof t !== 'object' || Array.isArray(t) || typeof t.trackId !== 'string' || !HEX24_RE.test(t.trackId)) throw localError('bad_request')
  if (Object.keys(t).some((k) => !TRACK_KEYS.includes(k))) throw localError('bad_request')
  if (t.artistPage !== undefined && t.artistPage !== null && typeof t.artistPage !== 'boolean') throw localError('bad_request')
  return {
    track: { trackId: t.trackId, title: trackText(t.title, true), artist: trackText(t.artist, false), album: trackText(t.album, false), artistPage: t.artistPage === true },
    playing: body.playing
  }
}

// An id from a path, decoded and lower-cased ('' when it does not decode).
function decodeId (raw) {
  try {
    return decodeURIComponent(raw).toLowerCase()
  } catch {
    return ''
  }
}

// One value of a query string ("?v=..."), decoded; null when it is not there.
function queryParam (query, name) {
  if (typeof query !== 'string' || query.length < 2) return null
  for (const part of query.slice(1).split('&')) {
    const eq = part.indexOf('=')
    if ((eq === -1 ? part : part.slice(0, eq)) !== name) continue
    try {
      return decodeURIComponent(eq === -1 ? '' : part.slice(eq + 1))
    } catch {
      return ''
    }
  }
  return null
}

// The results of the promises that settled within `ms` (each one resolves, never
// rejects), in no particular order.
function settledWithin (promises, ms) {
  const results = []
  return withTimeout(Promise.all(promises.map((p) => p.then((r) => { results.push(r) }))), ms).then(() => results.slice())
}

// GET /api/profile of a source with profiles.
function profileAnswer (p) {
  return p !== null && typeof p === 'object' && typeof p.role === 'string' &&
    (p.profileId === null || (typeof p.profileId === 'string' && HEX32_RE.test(p.profileId))) &&
    p.source !== null && typeof p.source === 'object' && typeof p.source.name === 'string'
}

// A source's refusal in the recovery flow, passed on with its code.
function sourceError (res) {
  const d = res.data || {}
  if (d.code === 'wrong_password') return localError('wrong_password', Number.isFinite(d.triesLeft) ? { triesLeft: d.triesLeft } : null)
  if (d.code === 'locked') return localError('locked', Number.isFinite(d.retryAt) ? { retryAt: d.retryAt } : null)
  if (d.code === 'no_recovery' || res.status === 404) return localError('no_recovery')
  return localError('failed')
}

// What, in a state, the events and the syncs care about.
function sourcesKey (st) {
  return JSON.stringify(st.sources.map((s) => [s.id, s.name, s.principal, s.addedAt, s.role, s.named, s.profiles, s.social]))
}

function socialKey (st) {
  return JSON.stringify(st.social)
}

function profileKey (st) {
  const p = st.profile
  return p === null ? 'null' : JSON.stringify([p.id, p.name, p.nameUpdatedAt, p.photo])
}

function photoKey (st) {
  const p = st.profile
  return p === null ? 'null' : JSON.stringify([p.id, p.photo, p.photoUpdatedAt])
}

// Everything the identity file and the recovery blob hold, but the blob's time.
function identityKey (st) {
  if (st.profile === null) return 'null'
  const p = st.profile
  const r = st.recovery
  return JSON.stringify([
    p.id, p.secret, p.name, p.nameUpdatedAt, st.clientSeed,
    st.sources.map((s) => [s.id, s.name, s.serverPublicKey, s.principal, s.addedAt]),
    r === null ? null : [r.salt, r.opslimit, r.memlimit, r.encKey, r.verifierHash]
  ])
}

function fileTime (st) {
  return st.recovery === null ? '' : '|' + st.recovery.updatedAt
}
