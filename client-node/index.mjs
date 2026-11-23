// MPfy on the PC: the client core (client-core/, the same one the Android app runs
// in its worklet) under Node, so the UI works from a browser over the real P2P path.
//
//   node client-node/index.mjs                         run: http://127.0.0.1:47123/
//   node client-node/index.mjs run                     the same
//   node client-node/index.mjs add <code>              add a source and exit
//   node client-node/index.mjs profile                 show this PC's profile
//   node client-node/index.mjs profile new <name>      make a profile here
//   node client-node/index.mjs profile import          bring a profile in by its code
//                                                      (MPFY-P-...), asked for or piped
//   node client-node/index.mjs profile import <file.mpfy>
//                                                      bring a profile in from its file
//   node client-node/index.mjs profile export [file]   write the profile file (.mpfy);
//                                                      given a folder, it goes in there
//
// The profile code is read from the input, never from the command line: the
// shell keeps the command line in its history, and other users of the machine
// can read it while the command runs.
//
// One client per state file. The core keeps the state in memory and rewrites the
// whole file on every change, so a second core on the same file would silently
// undo what the first one added (or the other way round). The client holding a
// state file says so in <state>.lock: { pid, port, role, nonce } (port null for
// the second or so it takes to start).
// - "run" takes the lock, or refuses when a live client holds it.
// - "add" and "profile" go through the client that holds the lock, whatever port
//   it listens on (a new link starts at once); when there is none, they take the
//   lock and run the core for a moment on a free port, do their part and stop.
// A lock left behind (a crash, a killed process) names a process that is gone, or
// a reused pid that does not listen on the lock's port: it is taken over.
//
// Environment: MPFY_CLIENT_STATE (default client-node/state.json),
//              MPFY_CLIENT_PORT (default 47123, for run), MPFY_CLIENT_WEB (default
//              ../web), MPFY_CLIENT_DEBUG (any value: print the core's log lines).

import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClientCore, DEFAULT_PORT } from '../client-core/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
export const DEFAULT_STATE = path.join(here, 'state.json')
export const DEFAULT_WEB = path.resolve(here, '..', 'web')
export const DEVICE_NAME = 'PC'
const ADD_TIMEOUT = 120000
// A lock without a port belongs to a client that is starting (about a second);
// one older than this was left by a client that died while starting.
export const LOCK_STARTING_MS = 60000
const PROBE_TIMEOUT_MS = 2000
// Errors a rename may hit on Windows while another process (an antivirus scan, a
// reader of the lock) holds the target open for a moment.
const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])

export function settingsFromEnv (env = process.env) {
  let port = DEFAULT_PORT
  const v = env.MPFY_CLIENT_PORT
  if (v !== undefined && v !== '') {
    port = Number(v)
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('MPFY_CLIENT_PORT non è una porta valida: ' + v)
  }
  return {
    statePath: path.resolve(env.MPFY_CLIENT_STATE || DEFAULT_STATE),
    webRoot: path.resolve(env.MPFY_CLIENT_WEB || DEFAULT_WEB),
    port
  }
}

// ------------------------------------------------------------------ the lock

export function lockPathOf (statePath) {
  return path.resolve(statePath) + '.lock'
}

/**
 * The client holding this state file: { pid, port, role } (port null while it is
 * starting), or null when no live client holds it.
 */
export async function lockHolder (statePath) {
  const file = lockPathOf(statePath)
  let text
  let mtimeMs
  try {
    mtimeMs = fs.statSync(file).mtimeMs
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
  const young = Date.now() - mtimeMs < LOCK_STARTING_MS
  let info = null
  try {
    info = JSON.parse(text)
  } catch {}
  if (info === null || typeof info !== 'object' || !Number.isInteger(info.pid) || info.pid <= 0) {
    // Empty: a client is writing it this very instant. Anything else: garbage.
    return young && text === '' ? { pid: null, port: null, role: null } : null
  }
  if (!pidAlive(info.pid)) return null
  const role = info.role === 'add' || info.role === 'cmd' ? info.role : 'run'
  const port = Number.isInteger(info.port) && info.port > 0 && info.port <= 65535 ? info.port : null
  if (port === null) return young ? { pid: info.pid, port: null, role } : null
  // After a crash the pid may belong to another program by now: a live client
  // also listens on the port it wrote.
  if (!(await portAnswers(port))) return null
  return { pid: info.pid, port, role }
}

/**
 * Take the lock of a state file for `role` ('run', 'add' or 'cmd'). Rejects with
 * .code 'LOCKED' (and .holder) when a live client holds it.
 */
export async function acquireLock (statePath, role) {
  const file = lockPathOf(statePath)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const info = { pid: process.pid, port: null, role, nonce: crypto.randomBytes(8).toString('hex') }
  for (let attempt = 0; ; attempt++) {
    let fd
    try {
      fd = fs.openSync(file, 'wx', 0o600)
    } catch (err) {
      if (err.code !== 'EEXIST' || attempt >= 3) throw err
      const holder = await lockHolder(statePath)
      if (holder !== null) throw lockedError(holder)
      // Left behind by a client that is gone: take it over. Two clients started
      // in the very same instant over a stale lock could both get here; nothing
      // narrower is possible with plain files.
      try {
        fs.unlinkSync(file)
      } catch (e) {
        if (e.code !== 'ENOENT') throw e
      }
      continue
    }
    try {
      fs.writeSync(fd, JSON.stringify(info) + '\n')
    } finally {
      fs.closeSync(fd)
    }
    return new StateLock(file, info)
  }
}

class StateLock {
  constructor (file, info) {
    this.file = file
    this.info = info
    this.released = false
  }

  /** Record the port once the core listens (the file is replaced atomically). */
  async setPort (port) {
    this.info = { ...this.info, port }
    await replaceFile(this.file, JSON.stringify(this.info) + '\n')
  }

  /** Remove the lock if it is still this one. Synchronous: also runs on 'exit'. */
  release () {
    if (this.released) return
    this.released = true
    let now = null
    try {
      now = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch {}
    if (now === null || now.pid !== this.info.pid || now.nonce !== this.info.nonce) return
    try {
      fs.unlinkSync(this.file)
    } catch {}
  }
}

async function replaceFile (file, text) {
  const tmp = file + '.' + process.pid + '.tmp'
  // Always a new file of our own: whatever is already at that name (left by a
  // crash, or put there by someone else) is never written through, and 0600 holds.
  try {
    fs.unlinkSync(tmp)
  } catch {}
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' })
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, file)
        return
      } catch (err) {
        if (attempt >= 8 || !RETRY_CODES.has(err.code)) throw err
        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)))
      }
    }
  } catch (err) {
    try {
      fs.unlinkSync(tmp)
    } catch {}
    throw err
  }
}

function pidAlive (pid) {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM' // it exists, it is just not ours to signal
  }
}

function portAnswers (port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const done = (ok) => {
      clearTimeout(timer)
      socket.destroy()
      resolve(ok)
    }
    const timer = setTimeout(() => done(false), PROBE_TIMEOUT_MS)
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

function lockedError (holder) {
  let message
  if (holder.role === 'add') message = 'un\'altra fonte è in aggiunta: riprova tra poco'
  else if (holder.role === 'cmd') message = 'un altro comando è in corso: riprova tra poco'
  else if (holder.port === null) message = 'MPfy si sta avviando: riprova tra poco'
  else message = 'MPfy è già aperto: http://127.0.0.1:' + holder.port + '/'
  const err = new Error(message)
  err.code = 'LOCKED'
  err.holder = holder
  return err
}

// ------------------------------------------------------------------ run and add

/**
 * Start the core, holding the lock of its state file. Resolves with { core,
 * port }; core.stop() ends it and releases the lock. `bootstrap` and `dht` are
 * passed to the core (tests).
 */
export async function runClient ({ statePath = DEFAULT_STATE, webRoot = DEFAULT_WEB, port = DEFAULT_PORT, onEvent = null, log = null, bootstrap, dht } = {}) {
  const lock = await acquireLock(statePath, 'run')
  const core = createClientCore({ statePath, webRoot, port, deviceName: DEVICE_NAME, onEvent, log, bootstrap, dht })
  let started
  try {
    started = await core.start()
    await lock.setPort(started.port)
  } catch (err) {
    try {
      await core.stop()
    } finally {
      lock.release()
    }
    throw err
  }
  const stop = async () => {
    try {
      await core.stop()
    } finally {
      lock.release()
    }
  }
  return { core: { ...core, stop }, port: started.port, lock }
}

/**
 * One request to the core of a state file: through the client holding it when
 * there is one, otherwise through a core started just for this, holding the lock
 * meanwhile under `role` (`bootstrap` and `dht` are passed to it: tests).
 * @returns {Promise<{ status: number, data: object|null, via: 'running'|'temporary' }>}
 */
export async function callCore ({ method, urlPath, body = null, statePath = DEFAULT_STATE, webRoot = DEFAULT_WEB, role = 'cmd', bootstrap, dht } = {}) {
  for (let attempt = 0; ; attempt++) {
    const holder = await lockHolder(statePath)
    if (holder !== null) {
      if (holder.role !== 'run' || holder.port === null) throw lockedError(holder)
      try {
        return { ...(await localJson(holder.port, method, urlPath, body)), via: 'running' }
      } catch (err) {
        if (err.code !== 'ECONNREFUSED' || attempt > 0) throw err
        continue // it closed this very instant: look again
      }
    }
    let lock
    try {
      lock = await acquireLock(statePath, role)
    } catch (err) {
      if (err.code !== 'LOCKED' || attempt > 0) throw err
      continue // a client started this very instant: go through it
    }
    const core = createClientCore({ statePath, webRoot, port: 0, deviceName: DEVICE_NAME, bootstrap, dht })
    try {
      const started = await core.start()
      await lock.setPort(started.port)
      return { ...(await localJson(started.port, method, urlPath, body)), via: 'temporary' }
    } finally {
      try {
        await core.stop()
      } finally {
        lock.release()
      }
    }
  }
}

/**
 * Add a source with its pairing code (its name is the source's own).
 * @returns {Promise<{ source: object, via: 'running'|'temporary' }>}
 */
export async function addSource ({ code, statePath = DEFAULT_STATE, webRoot = DEFAULT_WEB, bootstrap, dht } = {}) {
  const res = await callCore({ method: 'POST', urlPath: '/local/sources', body: { code }, statePath, webRoot, role: 'add', bootstrap, dht })
  return { source: answer(res, 'source').source, via: res.via }
}

/**
 * The profile commands: [] shows it, ['new', name], ['import'] or ['import', '-']
 * (the code read from `stdin`), ['import', file], ['export', file?]. Returns the
 * lines to print.
 */
export async function profileCommand (args, { statePath = DEFAULT_STATE, webRoot = DEFAULT_WEB, cwd = process.cwd(), stdin = process.stdin, bootstrap, dht } = {}) {
  const call = (method, urlPath, body = null) => callCore({ method, urlPath, body, statePath, webRoot, bootstrap, dht })
  const [sub, ...rest] = args
  if (sub === undefined) {
    const data = answer(await call('GET', '/local/profile'))
    if (data.profile === null) return ['Nessun profilo su questo PC']
    return ['Profilo: ' + (data.profile.name || '(senza nome)') + ' (' + data.profile.id + ')', 'Recupero con password: ' + (data.recovery ? 'attivo' : 'disattivato')]
  }
  if (sub === 'new') {
    const data = answer(await call('POST', '/local/profile', { name: rest.join(' ') }), 'profile')
    return ['Profilo creato: ' + data.profile.name + ' (' + data.profile.id + ')']
  }
  if (sub === 'import') {
    const usage = 'uso: node client-node/index.mjs profile import (poi il codice MPFY-P-...) oppure profile import <file.mpfy>'
    const what = rest.join(' ').trim()
    let body
    if (what === '' || what === '-') {
      const code = await readLine(stdin, 'Codice del profilo: ')
      if (code === '') throw new Error(usage)
      body = { code }
    } else {
      body = importBody(path.resolve(cwd, what), what)
    }
    const data = answer(await call('POST', '/local/profile/import', body), 'profile')
    return ['Profilo: ' + (data.profile.name || '(senza nome)') + ' (' + data.profile.id + ')', 'Fonti: ' + data.sources.length]
  }
  if (sub === 'export') {
    // A folder (one that is there, or a name ending in a separator) gets the file
    // named after the profile. Checked before anything starts; a missing folder
    // is never made.
    const named = rest.join(' ')
    let folder = cwd
    let file = null
    if (named !== '') {
      const full = path.resolve(cwd, named)
      if (isFolder(full)) folder = full
      else if (named.endsWith('/') || named.endsWith(path.sep)) throw new Error('la cartella non esiste: ' + full)
      else {
        checkFolder(full)
        file = full
      }
    }
    const data = answer(await call('GET', '/local/profile/export'), 'identity')
    const target = file !== null ? file : path.resolve(folder, data.fileName)
    // It holds this PC's key and the profile secret: only for its owner.
    await writeProfileFile(target, JSON.stringify(data.identity, null, 2) + '\n')
    return ['Profilo salvato in ' + target, 'Contiene l\'accesso alle tue fonti: tienilo per te.']
  }
  throw new Error('uso: node client-node/index.mjs profile [new <nome> | import [file] | export [file]]')
}

function isFolder (p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

// The folder a file goes in must be there already.
function checkFolder (file) {
  const folder = path.dirname(file)
  if (!isFolder(folder)) throw new Error('la cartella non esiste: ' + folder)
}

// Our own words for a failure, never the system's text.
async function writeProfileFile (file, text) {
  try {
    keepIfUnwritable(file)
    await replaceFile(file, text)
  } catch (err) {
    if (err.code === 'ENOENT') checkFolder(file)
    throw new Error('impossibile scrivere ' + file)
  }
}

// A rename replaces a file whatever its own permissions (on Linux a read-only
// one, on Windows one whose writing is denied): a file we cannot write stays.
function keepIfUnwritable (file) {
  let fd
  try {
    fd = fs.openSync(file, 'r+')
  } catch (err) {
    if (err.code === 'ENOENT') return
    throw err
  }
  fs.closeSync(fd)
}

// A file to import; anything else on the command line is still taken as a code
// (it is in the shell's history already: refusing it would only make it typed twice).
function importBody (file, what) {
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    if (fs.statSync(file).size > 256 * 1024) throw new Error('File non valido')
    return { identity: fs.readFileSync(file, 'utf8') }
  }
  return { code: what }
}

/**
 * The first line of `input`, trimmed ('' when it ends first). On a terminal the
 * prompt goes to stderr first. Afterwards the input is let go (paused, and its
 * handle no longer holds the process), so the process can end while a terminal
 * or a pipe keeps it open.
 */
export function readLine (input = process.stdin, prompt = null) {
  if (prompt !== null && input.isTTY) process.stderr.write(prompt)
  return new Promise((resolve, reject) => {
    let text = ''
    const done = (err) => {
      input.off('data', ondata)
      input.off('end', onend)
      input.off('error', done)
      input.pause()
      if (typeof input.unref === 'function') input.unref()
      if (err) {
        reject(err)
        return
      }
      const nl = text.indexOf('\n')
      resolve((nl === -1 ? text : text.slice(0, nl)).trim())
    }
    const ondata = (chunk) => {
      text += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
      if (text.includes('\n') || text.length > 4096) done(null)
    }
    const onend = () => done(null)
    input.on('data', ondata)
    input.on('end', onend)
    input.on('error', done)
    input.resume()
  })
}

function answer (res, field = null) {
  const data = res.data
  if (res.status >= 200 && res.status < 300 && data !== null && (field === null || data[field])) return data
  const err = new Error((data && data.error) || 'Qualcosa non ha funzionato')
  err.status = res.status
  err.code = data && data.code
  throw err
}

function localJson (port, method, urlPath, obj = null) {
  const payload = obj === null ? null : JSON.stringify(obj)
  const headers = payload === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, agent: false, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        let data = null
        try {
          data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {}
        resolve({ status: res.statusCode, data })
      })
      res.on('error', reject)
    })
    req.setTimeout(ADD_TIMEOUT, () => req.destroy(new Error('Nessuna risposta')))
    req.on('error', reject)
    req.end(payload === null ? undefined : payload)
  })
}

function describe (s) {
  return s.name + ': ' + (s.connected
    ? 'collegata' + (Number.isFinite(s.rttMs) ? ' (' + s.rttMs + ' ms)' : '')
    : 'non raggiungibile' + (s.lastError ? ' (' + s.lastError + ')' : ''))
}

async function main (argv) {
  const settings = settingsFromEnv()
  const cmd = argv[0]

  if (cmd === 'add') {
    if (!argv[1]) throw new Error('uso: node client-node/index.mjs add <codice>')
    console.log('Aggiunta della fonte in corso...')
    // A code typed with spaces arrives in pieces.
    const { source } = await addSource({ code: argv.slice(1).join(' '), statePath: settings.statePath, webRoot: settings.webRoot })
    console.log('Fonte aggiunta: ' + source.name + ' (' + source.id + ')' + (source.principal ? ', principale' : ''))
    return
  }
  if (cmd === 'profile') {
    for (const line of await profileCommand(argv.slice(1), settings)) console.log(line)
    return
  }
  if (cmd !== undefined && cmd !== 'run') throw new Error('comando sconosciuto: ' + cmd + ' (usa run, add <codice> oppure profile)')

  const last = new Map()
  const { core, port, lock } = await runClient({
    ...settings,
    log: process.env.MPFY_CLIENT_DEBUG ? (line) => console.log(new Date().toISOString() + ' ' + line) : null,
    onEvent: (event) => {
      if (event.type !== 'sources') return
      for (const s of event.sources) {
        const line = describe(s)
        if (last.get(s.id) === s.connected + '|' + s.lastError) continue
        last.set(s.id, s.connected + '|' + s.lastError)
        console.log(new Date().toISOString() + ' ' + line)
      }
      for (const id of [...last.keys()]) if (!event.sources.some((s) => s.id === id)) last.delete(id)
    }
  })
  // Whatever ends the process, the lock goes with it.
  process.on('exit', () => lock.release())
  console.log('MPfy: http://127.0.0.1:' + port + '/')
  if (core.state().sources.length === 0) console.log('Nessuna fonte: aggiungila dalla pagina o con "node client-node/index.mjs add <codice>"')
  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    await core.stop()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  // Closing the console window on Windows: Node gets SIGHUP and a few seconds.
  process.on('SIGHUP', stop)
}

// Started through a junction or a symbolic link, argv[1] keeps the path as typed
// while import.meta.url names the real file: compare real paths, or the command
// would silently do nothing.
function isMainModule () {
  const arg = process.argv[1]
  if (!arg) return false
  const real = (p) => {
    let r
    try {
      r = fs.realpathSync.native(p)
    } catch {
      r = fs.realpathSync(p)
    }
    return process.platform === 'win32' ? r.toLowerCase() : r
  }
  try {
    return real(path.resolve(arg)) === real(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isMainModule()) {
  main(process.argv.slice(2)).catch((err) => {
    const message = err.code === 'EADDRINUSE'
      ? 'la porta è già in uso: MPfy è già aperto? (MPFY_CLIENT_PORT sceglie un\'altra porta)'
      : err.message
    console.error('Errore: ' + message)
    process.exit(1)
  })
}
