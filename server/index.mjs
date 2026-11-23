// MPfy source: the server, and its command line.
//
//   node server/index.mjs                        run the server
//   node server/index.mjs code                   print the permanent pairing code (with no
//                                                owner yet, also open the owner window: 30 min)
//   node server/index.mjs rotate-code            make a new code (the old one stops working)
//   node server/index.mjs clients                list the paired devices
//   node server/index.mjs revoke <publicKey>     remove a device (and drop its connections)
//   node server/index.mjs profiles               list the people, their role and devices
//   node server/index.mjs claim [minutes]        open the owner window (default 30, max 1440)
//   node server/index.mjs set-owner <profileId> [--move-data]
//                                                make that profile the owner (--move-data:
//                                                the previous owner's data and tracks move too)
//   node server/index.mjs remove-profile <profileId>
//                                                remove a person: devices, data, recovery
//   node server/index.mjs details on|off         track details from the network (AcoustID,
//                                                MusicBrainz, Cover Art Archive): on or off
//   node server/index.mjs acoustid-key <key>     this source's own AcoustID key
//   node server/index.mjs acoustid-key --default back to the built-in key
//   node server/index.mjs export-compat          with the server stopped: write db.json and
//                                                users/*.json from the logs, in the format an
//                                                older MPfy reads (before going back to one)
//   node server/index.mjs card                   the memory cards found, and the one in use
//   node server/index.mjs card use [<scheda>]    put the music on that card (moved by the server)
//   node server/index.mjs card off               bring the music back to internal memory
//   node server/index.mjs card forget [--yes]    stop counting on a card that broke or was lost
//
// The commands work whether the server runs or not: they ask the running server
// on 127.0.0.1:MPFY_PORT first (so it applies the change at once) and edit the
// files in MPFY_DATA themselves when nobody answers; the server finishes any
// change of owner (moving the data) at its next start.
//
// Environment:
//   MPFY_DATA             data directory (default ./data)
//   MPFY_PORT             HTTP API port, 127.0.0.1 (default 8091)
//   MPFY_ADMIN_PORT       admin port, 127.0.0.1 (default 8092)
//   MPFY_NAME             source name shown in the app (default: the host name)
//   MPFY_WEB              serve a UI from this directory (development only)
//   MPFY_P2P              "0" to run without the HyperDHT link (development)
//   MPFY_ALLOWED_HOSTS    extra Host names accepted besides 127.0.0.1/localhost
//   MPFY_FFMPEG           ffmpeg command (default "ffmpeg" on PATH)
//   MPFY_FPCALC           fpcalc command (default "fpcalc" on PATH)
//   MPFY_7Z               7-Zip command (default: the first of 7zz, 7z that is 25.01 or later)
//   MPFY_7Z_MEM_BYTES     memory cap of 7-Zip under prlimit (default 536870912)
//   MPFY_MIN_FREE_BYTES   disk floor kept free (default the larger of 2 GiB and 5%)
//   MPFY_TRANSCODE_CAP_GB size cap of the transcodes (default 10)
//   MPFY_CARDS            where memory cards are mounted (default /storage when it exists)
//   MPFY_CARD_MIN_FREE_BYTES  floor kept free on the card (default the larger of 1 GiB and 2%)

import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import b4a from 'b4a'
import DHT from 'hyperdht'
import { createMPfy } from './app.mjs'
import { Library } from './library.mjs'
import { Places, VOLUME_RE } from './places.mjs'
import { storageView, storageAction, viewLines, sizeText, countText, CARD_USAGE } from './storage.mjs'
import { loadOrCreateSeed } from './keys.mjs'
import { Users } from './users.mjs'
import { PairingStore } from './pairing.mjs'
import { ClientsStore } from './clients.mjs'
import { SourceStore } from './source.mjs'
import { ProfilesStore } from './profiles.mjs'
import { ensureSourceFile } from './people.mjs'
import { isPublicKey, isProfileId } from './ids.mjs'
import { DEFAULT_MEM_BYTES } from './sevenzip.mjs'
import { DETAILS_URLS, ACOUSTID_KEY_RE } from './details.mjs'
import { LRCLIB_URL } from './lyrics.mjs'
import { ensureDir, log, logError, unlinkQuiet } from './util.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

function envPort (name, fallback) {
  const v = process.env[name]
  if (v === undefined || v === '') return fallback
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(name + ' is not a valid port: ' + v)
  return n
}

function envCapBytes () {
  const v = process.env.MPFY_TRANSCODE_CAP_GB
  if (v === undefined || v === '') return 10 * 1024 ** 3
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) throw new Error('MPFY_TRANSCODE_CAP_GB is not a valid size: ' + v)
  return Math.round(n * 1024 ** 3)
}

function envBytes (name, fallback) {
  const v = process.env[name]
  if (v === undefined || v === '') return fallback
  const n = Number(v)
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(name + ' is not a valid size in bytes: ' + v)
  return n
}

function dataDirFromEnv () {
  return path.resolve(process.env.MPFY_DATA || './data')
}

async function runServer () {
  const dataDir = dataDirFromEnv()
  const webDir = process.env.MPFY_WEB ? path.resolve(here, process.env.MPFY_WEB) : null
  const app = await createMPfy({
    dataDir,
    webDir,
    port: envPort('MPFY_PORT', 8091),
    adminPort: envPort('MPFY_ADMIN_PORT', 8092),
    name: process.env.MPFY_NAME || os.hostname(),
    p2p: process.env.MPFY_P2P !== '0',
    waitForDht: false, // serve the API at once; the P2P side comes up when the DHT is reachable
    allowedHosts: process.env.MPFY_ALLOWED_HOSTS || '',
    ffmpeg: process.env.MPFY_FFMPEG || 'ffmpeg',
    fpcalc: process.env.MPFY_FPCALC || 'fpcalc',
    sevenZip: process.env.MPFY_7Z || undefined,
    sevenZipMemBytes: envBytes('MPFY_7Z_MEM_BYTES', DEFAULT_MEM_BYTES),
    minFreeBytes: envBytes('MPFY_MIN_FREE_BYTES', null),
    transcodeCapBytes: envCapBytes(),
    backgroundDelayMs: 10000, // let the boot settle before the start-up transcodes
    detailsUrls: DETAILS_URLS,
    lyricsUrl: LRCLIB_URL
  })

  const o = app.opened
  log('MPfy "' + app.name + '" listening: http://127.0.0.1:' + app.ports.http + '/ (admin 127.0.0.1:' + app.ports.admin + ')')
  log('data ' + dataDir + ', ' + app.library.tracks.size + ' track(s), db ' + o.status +
    (o.corruptFile ? ' (corrupt copy kept as ' + path.basename(o.corruptFile) + ')' : ''))
  log('server public key ' + app.serverPublicKey)
  log('pairing code: node server/index.mjs code')

  let stopping = false
  const stop = async (signal) => {
    if (stopping) return
    stopping = true
    log('stopping (' + signal + ')')
    const force = setTimeout(() => {
      app.library.flush()
      process.exit(0)
    }, 5000)
    force.unref()
    try {
      await app.close()
    } catch (err) {
      logError('close failed: ' + err.message)
    }
    process.exit(0)
  }
  process.on('SIGINT', () => stop('SIGINT'))
  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('SIGHUP', () => stop('SIGHUP'))
  // Whatever happens, pending library changes reach the disk.
  process.on('exit', () => app.library.flush())
  process.on('uncaughtException', (err) => {
    logError('uncaught exception: ' + (err && err.stack ? err.stack : err))
    app.library.flush()
    process.exit(1)
  })
}

// ----------------------------------------------------------------------- CLI

/**
 * Ask the running server (127.0.0.1:MPFY_PORT). Resolves { status, body } or null
 * when nothing listens there.
 */
export function askServer (method, urlPath, { port = envPort('MPFY_PORT', 8091), timeout = 20000, body = null } = {}) {
  const payload = body === null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), 'utf8')
  return new Promise((resolve, reject) => {
    const headers = { 'content-length': payload.length }
    if (body !== null) headers['content-type'] = 'application/json'
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, agent: false, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        let body = null
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {}
        resolve({ status: res.statusCode, body })
      })
      res.on('error', reject)
    })
    req.setTimeout(timeout, () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })))
    req.on('error', (err) => {
      if (err.code === 'ECONNREFUSED') resolve(null)
      else reject(err)
    })
    req.end(payload)
  })
}

function minutesText (n) {
  return n === 1 ? '1 minuto' : n + ' minuti'
}

// source.json for a command run while the server is stopped (made as the
// server would make it, so a data dir from before profiles still migrates).
function sourceStore (dataDir) {
  const source = new SourceStore(dataDir)
  ensureSourceFile(dataDir, source, new ClientsStore(dataDir), process.env.MPFY_NAME || os.hostname())
  return source
}

// Change source.json: through the server (a local PATCH, so it applies at once),
// else in the file, which the server reads at its next start.
async function patchSource (dataDir, port, patch) {
  const res = await askServer('PATCH', '/api/admin/source', { port, body: patch })
  if (res !== null) {
    if (res.status !== 200) throw failure(res)
    return
  }
  sourceStore(dataDir).update(patch)
}

// Open the owner window: through the server, else in source.json.
async function openClaim (dataDir, port, minutes) {
  const res = await askServer('POST', '/api/admin/claim', { port, body: { minutes } })
  if (res !== null) {
    if (res.status !== 200) throw failure(res)
    return res.body
  }
  const source = sourceStore(dataDir)
  if (source.ownerProfileId !== null) return { ownerProfileId: source.ownerProfileId, claimUntil: 0 }
  const claimUntil = Date.now() + minutes * 60000
  source.update({ claimUntil })
  return { ownerProfileId: null, claimUntil }
}

function profileLines (profiles, clients, ownerProfileId) {
  if (profiles.length === 0) return ['Nessun profilo.']
  const lines = []
  for (const p of profiles) {
    const role = p.profileId === ownerProfileId ? 'proprietario' : 'membro'
    lines.push(p.profileId + '  ' + (p.name || '(senza nome)') + '  ' + role)
    for (const c of clients.filter((x) => x.profileId === p.profileId)) {
      lines.push('    ' + (c.name || 'Dispositivo') + '  dal ' + new Date(c.addedAt).toISOString().slice(0, 10))
    }
  }
  return lines
}

function failure (res) {
  return new Error((res.body && res.body.error) || 'risposta ' + res.status + ' dal server')
}

/**
 * Run one CLI command. Returns the lines to print. Exported for the tests.
 * @param {string[]} argv
 * @param {object} [opts]
 * @param {string} [opts.dataDir]
 * @param {number} [opts.port]
 */
export async function runCommand (argv, { dataDir = dataDirFromEnv(), port = envPort('MPFY_PORT', 8091) } = {}) {
  const [cmd, arg] = argv
  ensureDir(dataDir)

  if (cmd === 'code') {
    // Straight from pairing.json (made when missing): works with or without the server.
    const code = new PairingStore(dataDir).code
    // Whoever deploys the source reads the code: with no owner yet, the first
    // profile that adds the source in the next 30 minutes becomes its owner.
    const claim = await openClaim(dataDir, port, 30)
    if (claim.ownerProfileId !== null) return [code]
    return [code, 'Nessun proprietario: chi aggiunge la fonte nei prossimi 30 minuti lo diventa.']
  }

  if (cmd === 'claim') {
    const minutes = argv[1] === undefined ? 30 : Number(argv[1])
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw new Error('uso: node server/index.mjs claim [minuti, da 1 a 1440]')
    const claim = await openClaim(dataDir, port, minutes)
    if (claim.ownerProfileId !== null) return ["La fonte ha gia' un proprietario."]
    return ['Finestra aperta per ' + minutesText(minutes) + ': il primo profilo che aggiunge la fonte ne diventa il proprietario.']
  }

  if (cmd === 'details') {
    if (arg !== 'on' && arg !== 'off') throw new Error('uso: node server/index.mjs details on|off')
    await patchSource(dataDir, port, { details: arg === 'on' })
    return ['Dettagli dalla rete: ' + (arg === 'on' ? 'attivi' : 'disattivati')]
  }

  if (cmd === 'acoustid-key') {
    const key = arg === '--default' ? null : String(arg || '')
    if (key !== null && !ACOUSTID_KEY_RE.test(key)) throw new Error('uso: node server/index.mjs acoustid-key <chiave, da 6 a 64 lettere e cifre> oppure --default')
    await patchSource(dataDir, port, { acoustidKey: key })
    return [key === null ? 'Chiave AcoustID predefinita' : 'Chiave AcoustID aggiornata']
  }

  if (cmd === 'profiles') {
    const res = await askServer('GET', '/api/admin/profiles', { port })
    if (res !== null) {
      if (res.status !== 200) throw failure(res)
      const cl = await askServer('GET', '/api/admin/clients', { port })
      if (cl === null || cl.status !== 200) throw failure(cl || { status: 0, body: null })
      const owner = (res.body.profiles.find((p) => p.role === 'owner') || {}).profileId || null
      return profileLines(res.body.profiles, cl.body.clients, owner)
    }
    const source = sourceStore(dataDir)
    return profileLines(new ProfilesStore(dataDir).active(), new ClientsStore(dataDir).list(), source.ownerProfileId)
  }

  if (cmd === 'set-owner') {
    const id = String(arg || '').toLowerCase()
    const moveData = argv.slice(2).includes('--move-data')
    if (!isProfileId(id)) throw new Error('uso: node server/index.mjs set-owner <profilo, 32 caratteri esadecimali> [--move-data]')
    const res = await askServer('POST', '/api/admin/owner', { port, body: { profileId: id, moveData } })
    if (res !== null) {
      if (res.status !== 200) throw failure(res)
      return ['Proprietario impostato: ' + id + (moveData ? ' (dati spostati)' : '') + '.']
    }
    const source = sourceStore(dataDir)
    const p = new ProfilesStore(dataDir).get(id)
    if (p === null || p.removedAt !== null) throw new Error('Profilo non trovato')
    const previous = source.ownerProfileId || 'owner'
    source.update({ ownerProfileId: id, claimUntil: 0, move: moveData && previous !== id ? { from: previous, to: id } : null })
    return ['Proprietario impostato: ' + id + (moveData ? ' (dati spostati al prossimo avvio)' : '') + ' (server spento).']
  }

  if (cmd === 'remove-profile') {
    const id = String(arg || '').toLowerCase()
    if (!isProfileId(id)) throw new Error('uso: node server/index.mjs remove-profile <profilo, 32 caratteri esadecimali>')
    const res = await askServer('DELETE', '/api/admin/profiles/' + id, { port })
    if (res !== null) {
      if (res.status !== 200) throw failure(res)
      return ['Profilo rimosso: dispositivi, dati e recupero eliminati.']
    }
    const source = sourceStore(dataDir)
    if (source.ownerProfileId === id) throw new Error("Non consentito: e' il profilo del proprietario")
    const profiles = new ProfilesStore(dataDir)
    if (!profiles.markRemoved(id)) throw new Error('Profilo non trovato')
    const clients = new ClientsStore(dataDir)
    for (const key of clients.boundTo(id)) clients.remove(key)
    unlinkQuiet(path.join(dataDir, 'recovery', id + '.json'))
    // Its users/ file goes at the next start, after any data move still waiting
    // there (set-owner --move-data from this profile, run just before).
    return ['Profilo rimosso (server spento): il resto al prossimo avvio.']
  }

  if (cmd === 'card') return cardCommand(argv.slice(1), { dataDir, port })

  if (cmd === 'export-compat') {
    const res = await askServer('GET', '/api/health', { port, timeout: 5000 })
    if (res !== null) throw new Error("Il server e' acceso: fermalo prima di esportare i dati.")
    const done = await exportCompat(dataDir)
    return ['Dati scritti per una versione precedente: ' + (done.library ? 'la libreria e ' : '') + done.people + (done.people === 1 ? ' persona.' : ' persone.')]
  }

  if (cmd === 'rotate-code') {
    const res = await askServer('POST', '/api/admin/code/rotate', { port })
    if (res !== null) {
      if (res.status !== 200) throw failure(res)
      return [res.body.code, 'Codice cambiato: il precedente non funziona piu\'.']
    }
    const store = new PairingStore(dataDir)
    store.load()
    store.rotate()
    return [store.code, 'Codice cambiato (server spento: lo usera\' al prossimo avvio).']
  }

  if (cmd === 'clients') {
    const res = await askServer('GET', '/api/admin/clients', { port })
    let list
    if (res !== null) {
      if (res.status !== 200) throw failure(res)
      list = res.body.clients
    } else {
      list = new ClientsStore(dataDir).list().map((c) => ({ ...c, connected: null }))
    }
    if (list.length === 0) return ['Nessun dispositivo collegato.']
    return list.map((c) => {
      const state = c.connected === true ? 'connesso' : c.connected === false ? 'non connesso' : 'server spento'
      return c.publicKey + '  ' + (c.name || 'Dispositivo') + '  dal ' + new Date(c.addedAt).toISOString().slice(0, 10) + '  ' + state +
        (c.legacy ? '  legacy' : '')
    })
  }

  if (cmd === 'revoke') {
    const key = String(arg || '').toLowerCase()
    if (!isPublicKey(key)) throw new Error('uso: node server/index.mjs revoke <chiave pubblica, 64 caratteri esadecimali>')
    const res = await askServer('DELETE', '/api/admin/clients/' + key, { port })
    if (res !== null) {
      if (res.status !== 200) throw failure(res)
      return ['Dispositivo rimosso: le sue connessioni sono state chiuse.']
    }
    if (!new ClientsStore(dataDir).remove(key)) throw new Error('Dispositivo non trovato')
    return ['Dispositivo rimosso (server spento).']
  }

  throw new Error('comando sconosciuto: ' + cmd + ' (usa code, rotate-code, clients, revoke <chiave>, profiles, claim [minuti], set-owner <profilo> [--move-data], remove-profile <profilo>, details on|off, acoustid-key <chiave>|--default, export-compat, o nessun comando per avviare il server)')
}

/**
 * export-compat, with the server stopped: db.json and every users/<key>.json written
 * from the logs in the formats an older MPfy reads, each in pieces by a temporary
 * file, synced and renamed; each log then knows the file written from it, so the
 * next start of this code keeps the logs as the truth while those files are as
 * written. The data dir is read as a start reads it (an old db.json migrated
 * first), never served. Exported for the tests.
 */
export async function exportCompat (dataDir) {
  // An older build knows only internal memory: with music on a card (in use,
  // away or malformed) it would drop those tracks.
  const source = new SourceStore(dataDir)
  if (source.exists() && source.data !== null && source.data.card !== undefined && source.data.card !== null) {
    throw new Error('Prima riporta la musica nella memoria interna: node server/index.mjs card off (con il server acceso).')
  }
  const users = new Users({ dataDir })
  users.load()
  const library = new Library({ dataDir, extraCoverIds: () => users.playlistCoverIds(), holdStart: true })
  try {
    await library.open()
    if (library.cardInUse !== null) throw new Error('Prima riporta la musica nella memoria interna: node server/index.mjs card off (con il server acceso).')
    if (library.legacyUserData !== null) {
      users.migrateLegacy('owner', library.legacyUserData)
      library.legacyUserData = null
    }
    await library.exportCompat()
    const people = await users.exportCompat()
    // An older build reads flat library/ and transcodes/ only.
    library.places.flattenSync()
    return { library: true, people }
  } finally {
    library.close()
    users.close()
  }
}

// The data dir's library and places, as a start reads them, for a card command
// run with the server stopped; what `fn` changes is written when they close.
async function withFiles (dataDir, fn) {
  const source = sourceStore(dataDir)
  const key = b4a.toString(DHT.keyPair(loadOrCreateSeed(dataDir)).publicKey, 'hex')
  const places = new Places({ dataDir, source, serverPublicKey: () => key, watch: false })
  const users = new Users({ dataDir })
  users.load()
  const library = new Library({ dataDir, extraCoverIds: () => users.playlistCoverIds(), holdStart: true, places })
  try {
    await library.open()
    return await fn({ places, library, moves: null, jobs: null })
  } finally {
    library.close()
    users.close()
    places.close()
  }
}

// The storage view and its choices: through the running server, else on the files.
async function storage (dataDir, port, body = null) {
  const res = await askServer(body === null ? 'GET' : 'PUT', '/api/admin/storage', { port, body })
  if (res !== null) {
    if (res.status !== 200) {
      const err = failure(res)
      err.code = res.body && res.body.code
      err.extra = res.body
      throw err
    }
    return { view: res.body, server: true }
  }
  const view = await withFiles(dataDir, (ctx) => body === null ? storageView(ctx) : storageAction(ctx, body))
  return { view, server: false }
}

async function cardCommand (args, { dataDir, port }) {
  const [sub, arg] = args
  if (sub === undefined) return viewLines((await storage(dataDir, port)).view)
  if (sub === 'use' && args.length <= 2) {
    let volume = arg
    if (volume === undefined) {
      const { view } = await storage(dataDir, port)
      const usable = view.found.filter((c) => c.usable)
      if (usable.length !== 1 || view.card !== null) {
        const lines = viewLines(view)
        if (usable.length > 1) lines.push('Scegli: node server/index.mjs card use <scheda>')
        return lines
      }
      volume = usable[0].volume
    }
    if (!VOLUME_RE.test(volume)) throw new Error(CARD_USAGE)
    const { server } = await storage(dataDir, port, { use: volume })
    return ['Musica sulla scheda ' + volume + ": quella nuova va li', quella che c'e' gia' ci viene spostata piano piano." + (server ? '' : ' (server spento: al prossimo avvio)')]
  }
  if (sub === 'off' && args.length === 1) {
    try {
      const { view } = await storage(dataDir, port, { leave: true })
      return ['La musica torna nella memoria interna: ' + countText(view.card !== null ? view.card.tracks : 0) + ' brani da spostare.']
    } catch (err) {
      if (err.code !== 'disk_full') throw err
      const need = err.extra && err.extra.needBytes
      const { view } = await storage(dataDir, port)
      const free = view.card !== null ? view.card.internalFreeBytes : null
      return ['Servono ' + sizeText(need) + ' liberi nella memoria interna (ora ' + sizeText(free) + ').']
    }
  }
  if (sub === 'forget' && (args.length === 1 || (args.length === 2 && arg === '--yes'))) {
    const { view } = await storage(dataDir, port)
    const n = view.card !== null ? view.card.tracks : 0
    if (arg !== '--yes') return ['I ' + countText(n) + ' brani della scheda usciranno dalla libreria (i file sulla scheda restano). Per confermare: node server/index.mjs card forget --yes']
    await storage(dataDir, port, { forget: true })
    return ['Scheda dimenticata: ' + countText(n) + ' brani tolti dalla libreria, i file sulla scheda restano.']
  }
  throw new Error(CARD_USAGE)
}

async function main (argv) {
  if (argv.length === 0 || argv[0] === 'run') return runServer()
  const lines = await runCommand(argv)
  for (const line of lines) console.log(line)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) {
  main(process.argv.slice(2)).catch((err) => {
    const commandMode = process.argv.length > 2 && process.argv[2] !== 'run'
    if (commandMode) console.error('Errore: ' + err.message)
    else logError('startup failed: ' + (err && err.stack ? err.stack : err))
    process.exit(1)
  })
}
