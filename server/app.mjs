// Assembles an MPfy source: library + people + uploads + media jobs (ffmpeg,
// fpcalc) + archives (yauzl, 7-Zip) + details from the network (AcoustID,
// MusicBrainz, Cover Art Archive) + comments and lyrics (tags, .lrc, LRCLIB) +
// HTTP API (8091) + admin (8092) + the HyperDHT transport (main and pairing
// listeners). Used by server/index.mjs and by the tests (random ports, temp
// data dirs).

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import b4a from 'b4a'
import DHT from 'hyperdht'
import { Library } from './library.mjs'
import { Users } from './users.mjs'
import { MAX_UPLOAD_BYTES } from './upload.mjs'
import { StaticFiles } from './static.mjs'
import { ClientsStore } from './clients.mjs'
import { PairingStore } from './pairing.mjs'
import { SourceStore } from './source.mjs'
import { ProfilesStore } from './profiles.mjs'
import { RecoveryStore } from './recovery.mjs'
import { SocialStore } from './social.mjs'
import { ChatStore, groupIdOf } from './chat.mjs'
import { CommentsStore } from './comments.mjs'
import { Lyrics } from './lyrics.mjs'
import { People, ensureSourceFile } from './people.mjs'
import { Disk } from './disk.mjs'
import { Places } from './places.mjs'
import { Moves } from './moves.mjs'
import { Fingerprints } from './fingerprint.mjs'
import { SevenZip, DEFAULT_MEM_BYTES } from './sevenzip.mjs'
import { PendingStore, PENDING_TTL } from './pending.mjs'
import { Archives } from './archives.mjs'
import { UploadSessions } from './sessions.mjs'
import { Pipeline, renderResult } from './pipeline.mjs'
import { loadOrCreateSeed } from './keys.mjs'
import { createApiHandler } from './http.mjs'
import { createAdminHandler, LegacyLibrary } from './admin.mjs'
import { parseExtraHosts } from './respond.mjs'
import { FfmpegRunner } from './ffmpeg.mjs'
import { MediaJobs, PRIORITY as JOB_PRIORITY } from './jobs.mjs'
import { Details, PACE, PRIORITY as LOOKUP_PRIORITY, userAgentOf } from './details.mjs'
import { ensureDir, log, logError } from './util.mjs'
import { MPfyTransportServer } from '../transport/server.js'
import { formatCode } from '../transport/code.js'

const HOST = '127.0.0.1' // both ports, always: the outside world only gets in over P2P
const PAIRING_POLL_MS = 10000 // pairing.json changed by the CLI while we run?
const ROTATE_LISTEN_WAIT = 15000
const SWEEP_MS = 60 * 1000
// Pairing: at most this many new admissions in any hour, a guard against abuse of
// the code. How many clients are admitted in all has no cap.
export const ADMIT_LIMITS = Object.freeze({ perHour: 20 })

export const SERVER_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  } catch {
    return '0.0.0'
  }
})()

function listen (server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, HOST, () => {
      server.off('error', reject)
      resolve(server.address().port)
    })
  })
}

function closeServer (server) {
  return new Promise((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  })
}

function withTimeout (promise, ms) {
  let timer = null
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((resolve) => { timer = setTimeout(resolve, ms) })
  ])
}

/**
 * Who may be admitted by the pairing listener: at most `perHour` new admissions
 * in any hour, however many keys are admitted already. A key already admitted is
 * only confirmed (it never counts).
 */
export class AdmissionLimiter {
  constructor ({ perHour = ADMIT_LIMITS.perHour, now = Date.now } = {}) {
    this.perHour = perHour
    this.now = now
    this._times = []
  }

  check (clients, key) {
    if (clients.has(key)) return
    const now = this.now()
    this._times = this._times.filter((t) => now - t < 3600000)
    if (this._times.length >= this.perHour) throw new Error('too many pairings this hour')
    this._times.push(now)
  }
}

/**
 * @param {object} opts
 * @param {string} opts.dataDir
 * @param {string|null} [opts.webDir]   serve a UI (development only; null: none)
 * @param {number} [opts.port=8091]     0 = random
 * @param {number} [opts.adminPort=8092]
 * @param {string} [opts.name]          source name at its first start (default: the host name)
 * @param {boolean} [opts.p2p=true]     start the HyperDHT transport
 * @param {boolean} [opts.waitForDht=true]  wait for the DHT announce before resolving
 * @param {number} [opts.maxUpload]
 * @param {Array} [opts.bootstrap]      DHT bootstrap nodes (default: public DHT)
 * @param {object} [opts.dht]          an existing HyperDHT node to use (tests); not destroyed on close
 * @param {string} [opts.allowedHosts]  extra Host names, comma separated
 * @param {string|object|null} [opts.ffmpeg='ffmpeg']  command, a runner object, or null (none)
 * @param {string|null} [opts.fpcalc='fpcalc']  command, or null (none)
 * @param {string|null|undefined} [opts.sevenZip]  command; undefined: 7zz then 7z; null: none
 * @param {number} [opts.sevenZipMemBytes]  prlimit cap of 7-Zip
 * @param {number|null} [opts.minFreeBytes]  disk floor (null: max(2 GiB, 5%))
 * @param {Function} [opts.statfs]  (tests)
 * @param {number} [opts.transcodeCapBytes]  cap of transcodes/ (default 10 GB)
 * @param {number} [opts.backgroundDelayMs=0]  wait before the start-up background fill
 * @param {object} [opts.pairLimits]    rate limits of the pairing listener (tests)
 * @param {object} [opts.admitLimits]   { perHour } (tests)
 * @param {number} [opts.pairProofTimeout]
 * @param {Function} [opts.whoIs]  (tests) stands in for the transport's port mapping
 * @param {{ acoustid, musicbrainz, caa }|null} [opts.detailsUrls]  base URLs of the three
 *   services (DETAILS_URLS in production); null: no lookups (the default, for tests)
 * @param {number} [opts.detailsFillDelayMs=60000]  wait before the background lookups
 * @param {object} [opts.detailsPace]  ms between two requests per service
 * @param {number} [opts.detailsPollMs]  how often source.json is looked at for the switch
 * @param {() => number} [opts.detailsNow]  the clock of the lookup records (tests)
 * @param {number[]} [opts.detailsBackoff]  the pauses after a 429 or 503 (tests)
 * @param {number} [opts.detailsRetryBaseMs]  the first wait before a failed lookup runs again (tests)
 * @param {number[]} [opts.detailsOfflinePause]  the waits while the network gives no answer (tests)
 * @param {() => number} [opts.socialNow]  the clock of the social part (tests)
 * @param {{ cardDelayMs?: number, recentDelayMs?: number }} [opts.socialDelays]  when a person's
 *   social file is written after a change (tests)
 * @param {string|null} [opts.lyricsUrl]  the LRCLIB base URL (LRCLIB_URL in production); null:
 *   never asked (the default, for tests)
 * @param {object} [opts.lyricsOptions]  the timings of the lyrics (tests): fillDelayMs, paceMs,
 *   pollMs, now, backoff, retryBaseMs, missRetryMs, offlinePause, publishMs
 * @param {number} [opts.commentsDelayMs]  when a track's comments file is written after a change (tests)
 * @param {string|null} [opts.cardsDir]  where memory cards are mounted (MPFY_CARDS; default: places.mjs)
 * @param {object} [opts.placesOptions]  the timings and calls of the places (tests)
 */
export async function createMPfy ({
  dataDir,
  webDir = null,
  port = 8091,
  adminPort = 8092,
  name = os.hostname(),
  p2p = true,
  waitForDht = true,
  maxUpload = MAX_UPLOAD_BYTES,
  bootstrap,
  dht = null,
  allowedHosts = '',
  debounceMs = 500,
  ffmpeg = 'ffmpeg',
  fpcalc = 'fpcalc',
  sevenZip = undefined,
  sevenZipMemBytes = DEFAULT_MEM_BYTES,
  minFreeBytes = null,
  statfs,
  transcodeCapBytes = 10 * 1024 ** 3,
  backgroundDelayMs = 0,
  pendingTtlMs = PENDING_TTL,
  archiveWatch = {},
  pairLimits,
  admitLimits = {},
  pairProofTimeout,
  pairingPollMs = PAIRING_POLL_MS,
  sweepMs = SWEEP_MS,
  whoIs: whoIsOverride = null,
  detailsUrls = null,
  detailsFillDelayMs = 60000,
  detailsPace = PACE,
  detailsPollMs,
  detailsNow,
  detailsBackoff,
  detailsRetryBaseMs,
  detailsOfflinePause,
  socialNow,
  socialDelays = {},
  lyricsUrl = null,
  lyricsOptions = {},
  commentsDelayMs,
  cardsDir,
  placesOptions = {}
} = {}) {
  dataDir = path.resolve(dataDir)
  ensureDir(dataDir)
  const firstName = String(name || 'MPfy').trim() || 'MPfy'

  // People and their data: what each person's log says of itself, nobody loaded.
  let library = null
  const users = new Users({ dataDir, debounceMs, releaseCover: (coverId) => library && library.dropCoverIfUnused(coverId) })
  users.load()
  const clients = new ClientsStore(dataDir)
  const profiles = new ProfilesStore(dataDir)
  const source = new SourceStore(dataDir)
  const recovery = new RecoveryStore(dataDir)
  const social = new SocialStore({ dataDir, ...(socialNow ? { now: socialNow } : {}), ...socialDelays })
  const comments = new CommentsStore({ dataDir, isRemoved: (pid) => profiles.isRemoved(pid), ...(socialNow ? { now: socialNow } : {}), ...(commentsDelayMs !== undefined ? { writeDelayMs: commentsDelayMs } : {}) })
  comments.load()

  // Data from before profiles, step 1: the devices paired then are the owner's.
  ensureSourceFile(dataDir, source, clients, firstName)

  // The start's changes stay open until the transcodes and the lyrics are known
  // (finishStart below), so a derived change made while the source was stopped is
  // written with them.
  // Where the track files are: internal memory, and the memory card the owner chose.
  const disk = new Disk({ dataDir, minFreeBytes, ...(statfs ? { statfs } : {}) })
  let publicKeyHex = null
  const places = new Places({ dataDir, ...(cardsDir !== undefined ? { cardsDir } : {}), source, serverPublicKey: () => publicKeyHex, disk, ...placesOptions })
  library = new Library({ dataDir, extraCoverIds: () => users.playlistCoverIds(), holdStart: true, places })
  const opened = await library.open()
  // Step 2: the owner's playlists, likes and recents move to users/; the library
  // log is made at the end of the start, after them (db.json is left as it is).
  if (library.legacyUserData !== null) {
    users.migrateLegacy('owner', library.legacyUserData)
    library.legacyUserData = null
    library.flushNow()
  }
  // Playlist covers whose image is gone: lines in the logs of the people, none of them loaded.
  users.dropMissingCovers((id) => library.coverExists(id))

  const seed = loadOrCreateSeed(dataDir)
  const pairing = new PairingStore(dataDir)
  pairing.load()
  const extraHosts = parseExtraHosts(allowedHosts)

  // Tools.
  let runner = null
  if (typeof ffmpeg === 'string' && ffmpeg !== '') runner = new FfmpegRunner({ command: ffmpeg })
  else if (ffmpeg && typeof ffmpeg === 'object') runner = ffmpeg
  const fingerprints = new Fingerprints({ dataDir, command: fpcalc || null, library })
  library.onSlotFree = (slot) => fingerprints.dropSlot(slot)
  const seven = new SevenZip({ command: typeof sevenZip === 'string' && sevenZip !== '' ? sevenZip : null, memBytes: sevenZipMemBytes })
  const probes = [fingerprints.probe()]
  if (sevenZip !== null) probes.push(seven.probe())
  await Promise.all(probes)
  if (!fingerprints.available) log('fpcalc not available: duplicates found by file hash only')
  if (!seven.available) log('7-Zip 25.01 or later not available: 7z and RAR archives refused')
  else log('7-Zip ' + seven.version + (seven.rar ? ' with RAR' : ' without RAR'))

  let details = null
  let lyrics = null
  const jobs = new MediaJobs({
    library,
    ffmpeg: runner,
    capBytes: transcodeCapBytes,
    backgroundDelayMs,
    disk,
    fingerprints,
    // A track from before whose tags were just read may be missing details now.
    onTagless: (track) => details.request(track.id, LOOKUP_PRIORITY.BACKGROUND)
  })
  library.qualitiesOf = (track) => jobs.qualities(track)
  library.onCardGone = () => jobs.dropCardLevels()
  library.onCardBack = (ids) => jobs.cardBack(ids)
  library.onDropped = (tracks) => {
    for (const t of tracks) {
      jobs.onTrackDeleted(t)
      fingerprints.indexRemove(t.id)
    }
  }
  const moves = new Moves({ library, jobs })
  lyrics = new Lyrics({ dataDir, library, source, url: lyricsUrl, userAgent: 'MPfy/' + SERVER_VERSION, jobs, ...lyricsOptions })
  lyrics.load()
  jobs.lyricsTags = lyrics
  library.lyricsOf = (id) => lyrics.flagOf(id)
  library.onTrackChange = (id, how) => lyrics.trackChanged(id, how)
  details = new Details({
    library,
    source,
    fingerprints,
    dataDir,
    urls: detailsUrls,
    userAgent: userAgentOf(SERVER_VERSION),
    onCover: (coverId) => jobs.requestCoverSizes(coverId, JOB_PRIORITY.BACKGROUND),
    fillDelayMs: detailsFillDelayMs,
    pace: detailsPace,
    ...(detailsPollMs ? { pollMs: detailsPollMs } : {}),
    ...(detailsNow ? { now: detailsNow } : {}),
    ...(detailsBackoff ? { backoff: detailsBackoff } : {}),
    ...(detailsRetryBaseMs ? { retryBaseMs: detailsRetryBaseMs } : {}),
    ...(detailsOfflinePause ? { offlinePause: detailsOfflinePause } : {})
  })

  let transport = null
  let pipeline = null
  let people = null
  const pending = new PendingStore({ dataDir, ttlMs: pendingTtlMs })
  pending.load()
  const archives = new Archives({
    dataDir, library, disk, sevenZip: seven, pipeline: () => pipeline, jobs, watch: archiveWatch, pendingExists: (id) => pending.byId(id) !== null, lookup: (id) => details.request(id), lyrics
  })
  archives.load()
  const sessions = new UploadSessions({
    dataDir,
    disk,
    sevenZip: seven,
    isOwner: (actor) => people.isOwnerActor(actor),
    finish: async (rec, file, hash) => {
      const caller = people.callerForActor(rec.profileId, { ask: rec.ask === true, clientKey: rec.clientKey })
      const result = await pipeline.ingest({ file, hash, size: rec.size, name: rec.name, caller })
      return renderResult(result, library, people.viewerForActor(rec.profileId))
    }
  })
  const rerun = sessions.load()
  disk.addReserver((exclude) => sessions.reservedBytes(exclude))
  disk.addReserver(() => archives.reservedBytes())
  pipeline = new Pipeline({
    library, jobs, fingerprints, ffmpeg: runner, ffmpegReady: () => jobs.ffmpegAvailable, pending, archives: () => archives, disk, isRemoved: (actor) => profiles.isRemoved(actor), lookup: (id) => details.request(id), lyrics
  })

  const serverPublicKey = b4a.toString(DHT.keyPair(seed).publicKey, 'hex')
  publicKeyHex = serverPublicKey
  // The chats: read before the removals of people.startup() drop what is theirs.
  const chat = new ChatStore({ dataDir, groupId: groupIdOf(serverPublicKey), isRemoved: (pid) => profiles.isRemoved(pid), ...(socialNow ? { now: socialNow } : {}) })
  await chat.load()
  social.chat = chat
  social.onChange = () => chat.notify(null)
  people = new People({ source, profiles, clients, users, recovery, social, chat, comments, library, sessions, pending, archives, fingerprints, transport: () => transport, serverPublicKey })
  // The merges of a change of owner are over before anything is served.
  await people.startup()

  // Fingerprints whose file is gone are made again in the background.
  for (const t of fingerprints.load(library.tracks.values())) library.setTrack({ ...t, fp: null, fpState: 'none' })

  const jobsStarted = jobs.start().catch((err) => logError('media jobs failed to start: ' + err.message))
  // transcodes/ is scanned (the first part of jobs.start) and the lyrics index
  // loaded: the start's changes are written now, before anything is served.
  await jobs.scanned.catch(() => {})
  await library.finishStart()
  details.start()
  // Comments and lyrics of tracks gone while the source was stopped go; the tracks
  // from before get their lyrics tags read; LRCLIB, with the switch on.
  const hasTrack = (id) => library.getTrack(id) !== null
  const songsStarted = Promise.all([
    comments.start(hasTrack).catch((err) => logError('comments failed to start: ' + err.message)),
    lyrics.start().catch((err) => logError('lyrics failed to start: ' + err.message))
  ])
  // Pipelines cut by a restart run again, so a client polling them gets an answer.
  jobsStarted.then(() => {
    for (const id of rerun) {
      const p = sessions.rerun(id)
      if (p) p.catch(() => {})
    }
  })

  // A file goes for good: its fingerprint, transcodes, and every person's references.
  // The job reading it stops first (on Windows a file a tool holds open cannot
  // go). Once it has stopped, `still(track)` says whether the track, as it is
  // then, still goes. Resolves true when the track is gone.
  const removeTrackFile = async (track, still = () => true) => {
    const stopped = await jobs.stopFor(track.id)
    const now = library.getTrack(track.id)
    if (now === null) return true
    if (!still(now)) {
      jobs.again(stopped)
      return false
    }
    library.deleteTrack(now.id)
    jobs.onTrackDeleted(now)
    fingerprints.remove(now.fileHash)
    fingerprints.indexRemove(now.id)
    users.removeTrackEverywhere(now.id)
    comments.dropTrack(now.id)
    lyrics.dropTrack(now.id)
    return true
  }

  const decidePending = async (rec, keep, caller) => {
    let result = { outcome: 'ignored' }
    try {
      result = await pipeline.decidePending(rec, keep, caller)
      return result
    } finally {
      // Its record is gone either way: so is its place in the archive.
      if (rec.archiveId) archives.resolvePending(rec.archiveId, rec.id, result)
    }
  }

  // Unanswered "maybe" uploads are decided "both"; old sessions and statuses go.
  const sweep = async () => {
    sessions.sweep()
    archives.sweep()
    social.sweep()
    for (const rec of pending.expired()) {
      if (!pending.take(rec.id)) continue
      try {
        await decidePending(rec, 'both', people.callerForActor(rec.profileId))
      } catch (err) {
        logError('pending upload ' + rec.id + ' could not be decided: ' + err.message)
      }
    }
  }
  const sweepTimer = setInterval(() => { sweep().catch(() => {}) }, sweepMs)
  sweepTimer.unref()

  let staticFiles = null
  if (webDir) {
    if (!fs.existsSync(webDir)) log('web directory not found: ' + webDir + ' (the API works, the UI will answer 404 until it exists)')
    staticFiles = new StaticFiles(webDir)
  }

  // Which admitted client a request came through (tests may stand in for the transport).
  const whoIs = whoIsOverride || ((req) => (transport !== null && req.socket ? transport.clientForPort(req.socket.remotePort) : null))

  async function rotateCode () {
    const secret = pairing.rotate()
    log('pairing code changed')
    if (transport !== null) {
      // Listen on the new key before answering, when the DHT lets us (bounded).
      await withTimeout(transport.setPairingSecret(secret).catch((err) => {
        log('pairing listener on the new code failed (' + err.message + '), retrying in ' + Math.round(transport.pairingRetryMs / 1000) + ' s')
      }), ROTATE_LISTEN_WAIT)
    }
    return formatCode(secret)
  }

  // The library requests of apps that read no deltas: counted by the API, shown by the admin port.
  const legacyLibrary = new LegacyLibrary(dataDir)
  const apiServer = http.createServer({
    requestTimeout: 0, // a 600 MB upload over mobile data can take a long time
    headersTimeout: 60000,
    keepAliveTimeout: 30000
  }, createApiHandler({
    library,
    users,
    people,
    source,
    profiles,
    clients,
    recovery,
    social,
    chat,
    comments,
    lyrics,
    pairing,
    jobs,
    fingerprints,
    sevenZip: seven,
    disk,
    places,
    moves,
    pipeline,
    details,
    sessions,
    pending,
    archives,
    removeTrackFile,
    decidePending,
    rotateCode,
    transport: () => transport,
    whoIs,
    staticFiles,
    extraHosts,
    serverVersion: SERVER_VERSION,
    maxUpload,
    dataDir,
    legacyLibrary
  }))
  // A client that half-closes after its request still gets the answer.
  apiServer.httpAllowHalfOpen = true

  const httpPort = await listen(apiServer, port)

  const admission = new AdmissionLimiter(admitLimits)
  let transportReady = Promise.resolve()
  if (p2p) {
    transport = new MPfyTransportServer({
      seed,
      isAllowed: (key) => clients.has(key),
      onPaired: (key, deviceName) => {
        // Past the hourly limit the pairing listener closes without admitting.
        admission.check(clients, key)
        clients.add(key, deviceName)
        log('paired device ' + key.slice(0, 16) + '... (' + deviceName + ')')
      },
      pairingSecret: pairing.secret,
      sourceName: () => source.name,
      targetPort: httpPort,
      bootstrap,
      dht,
      pairLimits,
      ...(pairProofTimeout ? { pairProofTimeout } : {})
    })
    // A failed listen on a new pairing code is retried by the transport itself.
    transport.on('pairing-error', (e) => log('pairing listener still failing (' + e.error + '), retrying in ' + Math.round(e.retryMs / 1000) + ' s'))
    transport.on('pairing-listening', () => log('pairing listener on the new code is up'))
    transport.on('pair-error', (e) => log('pairing refused: ' + e.error))
    transportReady = listenWithRetry(transport)
    if (waitForDht) await transportReady
  }

  // pairing.json rewritten by the CLI (rotate-code while we were unreachable).
  const pairingTimer = setInterval(() => {
    let secret = null
    try {
      secret = pairing.reloadIfChanged()
    } catch (err) {
      logError('pairing.json reload failed: ' + err.message)
    }
    if (secret !== null && transport !== null) {
      log('pairing.json changed on disk: listening on the new code')
      transport.setPairingSecret(secret).catch((err) => {
        log('pairing listener failed (' + err.message + '), retrying in ' + Math.round(transport.pairingRetryMs / 1000) + ' s')
      })
    }
  }, pairingPollMs)
  pairingTimer.unref()

  const adminServer = http.createServer({ headersTimeout: 30000, requestTimeout: 60000 },
    createAdminHandler({ clients, transport: () => transport, serverPublicKey, jobs, source, fingerprints, sevenZip: seven, details, lyrics, comments, extraHosts, legacyLibrary, places, library }))
  const adminListenPort = await listen(adminServer, adminPort)

  let closed = false
  return {
    library,
    users,
    clients,
    profiles,
    source,
    recovery,
    social,
    chat,
    comments,
    lyrics,
    songsStarted,
    pairing,
    jobs,
    jobsStarted,
    details,
    fingerprints,
    sevenZip: seven,
    disk,
    places,
    moves,
    sessions,
    pending,
    archives,
    pipeline,
    people,
    transport,
    serverPublicKey,
    get name () {
      return source.name
    },
    opened,
    ports: { http: httpPort, admin: adminListenPort },
    addresses: { http: apiServer.address(), admin: adminServer.address() },
    transportReady,
    rotateCode,
    sweep,
    get code () {
      return pairing.code
    },
    async close () {
      if (closed) return
      closed = true
      clearInterval(pairingTimer)
      clearInterval(sweepTimer)
      details.close()
      lyrics.stop()
      jobs.close()
      places.close()
      archives.close()
      seven.runner && seven.runner.close()
      fingerprints.runner && fingerprints.runner.close()
      // Requests waiting for a change of the chats answer now.
      const chatClosed = chat.close()
      await Promise.all([closeServer(apiServer), closeServer(adminServer)])
      await legacyLibrary.close()
      if (transport) await transport.close()
      await sessions.settle()
      library.close()
      users.close()
      social.close()
      comments.close()
      lyrics.close()
      await chatClosed
    }
  }
}

// The DHT may be unreachable at boot (phone without network yet): keep trying,
// the HTTP side works meanwhile.
async function listenWithRetry (transport) {
  while (!transport.closing) {
    try {
      await transport.listen()
      log('P2P ready, server key ' + b4a.toString(transport.publicKey, 'hex') + ', pairing key ' + transport.pairingPublicKey)
      return
    } catch (err) {
      if (transport.closing) return
      log('P2P listen failed (' + err.message + '), retrying in 30 s')
      await new Promise((resolve) => setTimeout(resolve, 30000).unref())
    }
  }
}
