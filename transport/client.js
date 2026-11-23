// MPfy transport, client side. Runs on Node (tests, the PC) and on Bare (bundled
// into the Android worklet): only portable modules (hyperdht, protomux, b4a,
// hypercore-crypto, compact-encoding, streamx) plus the '#net' import map
// (bare-tcp on Bare, net on Node). No Buffer, no process, no node: modules.
//
// ============================================================================
// EXPORTS (what client-core uses)
//
//   createDht({ bootstrap? } = {}) -> HyperDHT
//     One DHT node to share between every link and pair() call (one UDP socket,
//     less battery). Pass it as `dht`; the caller destroys it (await dht.destroy())
//     after closing the links. Without `dht`, a link or pair() makes its own.
//
//   generateKeyPair() -> { seed, publicKey, secretKey }        all hex strings
//   keyPairFromSeed(seed) -> { publicKey, secretKey }           hex strings
//     seed: 64 hex chars or 32 bytes. The client identity used with EVERY source
//     (client-core stores `clientSeed` and derives the pair at start).
//
//   parseCode(code) -> Uint8Array (the 20-byte secret)
//     Accepts "MPFY-7K3Q-9XWD-...", any case, spaces or dashes anywhere, with or
//     without the MPFY prefix; I and L read as 1, O as 0. Throws an Error whose
//     .code is 'INVALID_CODE' and .message "Codice non valido".
//   formatCode(secret) -> "MPFY-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
//   normalizeCode(code) -> the formatted code, or null when it does not parse
//   CODE_CHARS = 32 (characters after the prefix, 8 groups of 4)
//
//   pair(code, { keyPair, name?, dht?, bootstrap?, timeout = 30000 })
//     -> Promise<{ serverPublicKey: string (hex), name: string (source name) }>
//     Proves the code to the source's permanent pairing listener and sends `name`
//     (the device name, cut to 60 UTF-8 bytes; the source shows "Dispositivo" when
//     empty). Errors carry .code (and an Italian .message):
//       'INVALID_CODE'  the code does not parse ("Codice non valido")
//       'UNREACHABLE'   no connection on that code within `timeout`: source
//                       offline, a typo, a code rotated meanwhile, OR the source
//                       turning attempts away (too many failed proofs, too many
//                       connections waiting). Its firewall answers nothing, so a
//                       rate-limited attempt looks exactly like an offline source
//                       ("Fonte non raggiungibile")
//       'REFUSED'       a connection opened but closed with no answer: the code
//                       changed while pairing, the source could not store the
//                       device, or a limit was hit in the instant between the
//                       connection and the proof ("Abbinamento rifiutato")
//     and .detail (the low-level error, for logs).
//
//   class MPfyLink (event emitter: on, off, once)
//     new MPfyLink({ serverPublicKey, keyPair, dht?, bootstrap? })
//       serverPublicKey: hex or 32 bytes (from pair()); keyPair: hex or bytes.
//     .start()                 dial now and keep the link up for good: redial with
//                              backoff 1 s, 2 s, ... 30 s after every drop or failure
//     .status                  { connected: bool, rttMs: number|null, lastError: string|null }
//     event 'status'           the same object, on every change of connected or
//                              lastError, and every 5 s while connected (fresh rttMs)
//     .waitConnected(ms)       -> Promise<boolean>: true as soon as the link is up
//                              (dials at once if it is down), false after ms
//     .forward(socket, { head?, ondata?, timeout? })
//                              forward ONE local TCP socket (net / bare-tcp) to the
//                              source's HTTP port over a new channel: `head` (bytes
//                              already read from the socket, e.g. the rewritten
//                              request head plus any body bytes) goes first, then
//                              the socket's own data; the response is written back
//                              raw and the socket ended when the source ends. The
//                              socket must be paused (socket.pause()) with no other
//                              'data' listener. ondata(n) is called for every
//                              response chunk (throughput). While the link is down
//                              the socket waits up to `timeout` ms (default 30000),
//                              then is destroyed.
//     .openStream({ timeout? }) -> Promise<Duplex (streamx)> raw byte stream to the
//                              source's HTTP port (waits up to timeout for the link,
//                              default 6000; rejects with .code 'UNREACHABLE')
//     .request(method, path, { headers?, body?, timeout? })
//                              -> Promise<{ status: number, headers: object (lower-
//                              case names), body: Uint8Array }>. A small HTTP/1.1
//                              client over openStream, with Connection: close. body
//                              may be a string, bytes or a plain object (sent as
//                              JSON). Default timeout 10000 ms for the whole call.
//                              `path` must be printable ASCII: percent-encode the
//                              rest (encodeURIComponent), e.g. a file name; header
//                              values are Latin-1 at most. Anything else rejects
//                              ("percorso non valido", "intestazione non valida").
//                              E.g. link.request('DELETE', '/api/admin/clients/self',
//                              { timeout: 2000 }).
//     .refresh()               call on network changes (Wi-Fi <-> mobile)
//     .listen({ port?, host? }) -> Promise<{ host, port }>: a local TCP proxy where
//                              every accepted socket is forwarded raw (tests, dev)
//     .stats                   { dials, pipes: { opened, closed, bytesIn, ... } }
//     .close() -> Promise      stops everything (destroys its own DHT, not a shared one)
// ============================================================================

import DHT from 'hyperdht'
import Protomux from 'protomux'
import b4a from 'b4a'
import hcrypto from 'hypercore-crypto'
import net from '#net'
import { Emitter } from './emitter.js'
import { pipeSocket, newPipeStats } from './pipe.js'
import { channelStream, windowFor } from './stream.js'
import { controlClient } from './control.js'
import {
  parseCode, formatCode, normalizeCode, pairProof, pairSeedFromSecret, authKeyFromSecret,
  encodeName, decodeName, toKey, toKeyPair, errorText, MAX_NAME_BYTES
} from './code.js'

export { parseCode, formatCode, normalizeCode }
export const CODE_CHARS = 32

const BACKOFF_MIN = 1000
const BACKOFF_MAX = 30000
// A connection that lived this long counts as stable: the next drop restarts the
// backoff from 1 s.
const STABLE_AFTER = 10000
// Minimum gap between two "immediate" dials triggered by local demand, so a page
// hammering a dead link does not turn into a dial loop.
const MIN_DIAL_GAP = 1000
// No data for this long (keep-alives flow every 5 s) means the link is dead.
const LINK_TIMEOUT = 20000
// After a network change: a live link must show a sign of life within this time.
const PROBE_TIMEOUT = 8000
// Local sockets wait this long for the link before they are dropped.
const PENDING_TIMEOUT = 30000
const MAX_PENDING = 64
const STATUS_INTERVAL = 5000
// Ping on the control channel every this many status ticks, when the raw stream
// reports no round trip of its own.
const PING_EVERY_TICKS = 3
const REQUEST_TIMEOUT = 10000
const STREAM_WAIT = 6000

function linkError (code, message, detail = null) {
  const err = new Error(message)
  err.code = code
  if (detail !== null) err.detail = detail
  return err
}

/** One HyperDHT node to share between links and pair() calls. */
export function createDht ({ bootstrap } = {}) {
  return new DHT(bootstrap ? { bootstrap } : {})
}

/** A new client identity: { seed, publicKey, secretKey } as hex strings. */
export function generateKeyPair () {
  const seed = hcrypto.randomBytes(32)
  const kp = DHT.keyPair(seed)
  return {
    seed: b4a.toString(seed, 'hex'),
    publicKey: b4a.toString(kp.publicKey, 'hex'),
    secretKey: b4a.toString(kp.secretKey, 'hex')
  }
}

/** The key pair of a stored seed (64 hex chars or 32 bytes), as hex strings. */
export function keyPairFromSeed (seed) {
  const kp = DHT.keyPair(toKey(seed, 'seme'))
  return { publicKey: b4a.toString(kp.publicKey, 'hex'), secretKey: b4a.toString(kp.secretKey, 'hex') }
}

export class MPfyLink extends Emitter {
  /**
   * @param {object} opts
   * @param {Uint8Array|string} opts.serverPublicKey
   * @param {{publicKey, secretKey}} opts.keyPair  the client's persistent key pair (bytes or hex)
   * @param {object} [opts.dht]  a shared HyperDHT instance (otherwise one is created)
   * @param {Array} [opts.bootstrap]  DHT bootstrap nodes (default: the public DHT)
   */
  constructor ({ serverPublicKey, keyPair, dht = null, bootstrap } = {}) {
    super()
    this.serverPublicKey = toKey(serverPublicKey, 'chiave del server')
    this.keyPair = toKeyPair(keyPair)
    this.host = '127.0.0.1'
    this.port = 0
    this.stats = { dials: 0, pipes: newPipeStats() }

    this._ownDht = dht === null
    this._dht = dht || createDht({ bootstrap })
    this._tcp = null
    this._conn = null // the open connection
    this._mux = null
    this._ctl = null
    this._pingRtt = null
    this._dialing = null // a connection being established
    this._openedAt = 0
    this._lastDialAt = 0
    this._backoff = BACKOFF_MIN
    this._retryTimer = null
    this._probeTimer = null
    this._statusTimer = null
    this._ticks = 0
    this._pending = []
    this._waiters = new Set()
    this._lastError = null
    this._lastStatus = null
    this._closing = false

    this._onnetworkchange = () => this.refresh()
    this._dht.on('network-change', this._onnetworkchange)
  }

  get dht () {
    return this._dht
  }

  /** Dial now and keep the link up (redial with backoff after every drop). */
  start () {
    this._ensure(true)
  }

  /** Same as start() (its older name). */
  connect () {
    this._ensure(true)
  }

  /**
   * Call on network changes (Wi-Fi to mobile, back from a tunnel). A down link is
   * re-dialled at once; a link that looks up must prove it is alive quickly,
   * otherwise it is dropped and re-dialled.
   */
  refresh () {
    if (this._closing) return
    if (this._conn === null) {
      if (this._retryTimer !== null || this._pending.length > 0 || this._waiters.size > 0) this._ensure(true)
      return
    }
    const conn = this._conn
    conn.setTimeout(PROBE_TIMEOUT)
    if (this._probeTimer !== null) clearTimeout(this._probeTimer)
    this._probeTimer = setTimeout(() => {
      this._probeTimer = null
      if (this._conn === conn) conn.setTimeout(LINK_TIMEOUT)
    }, PROBE_TIMEOUT + 2000)
    if (this._ctl !== null) this._ctl.ping()
  }

  get status () {
    const connected = this._conn !== null
    return { connected, rttMs: connected ? this._rtt() : null, lastError: this._lastError }
  }

  _rtt () {
    const raw = this._conn !== null && this._conn.rawStream ? this._conn.rawStream.rtt : undefined
    if (typeof raw === 'number' && raw > 0) return Math.round(raw)
    return this._pingRtt
  }

  _emitStatus (force = false) {
    const status = this.status
    const last = this._lastStatus
    const changed = last === null || last.connected !== status.connected || last.lastError !== status.lastError
    if (!changed && !force) return
    this._lastStatus = status
    this.emit('status', status)
  }

  /** Resolves true once the link is up (dialling now if needed), false after timeoutMs. */
  waitConnected (timeoutMs = STREAM_WAIT) {
    if (this._linkUsable()) return Promise.resolve(true)
    if (this._closing) return Promise.resolve(false)
    this._ensure(true)
    return new Promise((resolve) => {
      const waiter = (ok) => {
        clearTimeout(timer)
        this._waiters.delete(waiter)
        resolve(ok)
      }
      const timer = setTimeout(() => waiter(false), timeoutMs)
      this._waiters.add(waiter)
    })
  }

  _ensure (now) {
    if (this._closing) return
    if (this._conn !== null || this._dialing !== null) return
    if (this._retryTimer !== null) {
      if (!now) return
      clearTimeout(this._retryTimer)
      this._retryTimer = null
    }
    const wait = this._lastDialAt + MIN_DIAL_GAP - Date.now()
    if (wait > 0) {
      this._retryTimer = setTimeout(() => {
        this._retryTimer = null
        this._dial()
      }, wait)
      return
    }
    this._dial()
  }

  _dial () {
    if (this._closing || this._conn !== null || this._dialing !== null) return
    this._lastDialAt = Date.now()
    this.stats.dials++
    let conn
    try {
      conn = this._dht.connect(this.serverPublicKey, { keyPair: this.keyPair })
    } catch (err) {
      // A DHT that cannot even start a dial (being torn down): try again later.
      this._lastError = errorText(err)
      this._emitStatus()
      this._scheduleRetry()
      return
    }
    this._dialing = conn
    conn.setTimeout(LINK_TIMEOUT)

    conn.on('open', () => {
      if (this._dialing === conn) this._dialing = null
      if (this._closing) {
        conn.destroy()
        return
      }
      this._conn = conn
      this._mux = Protomux.from(conn)
      this._pingRtt = null
      this._ctl = controlClient(this._mux, (rtt) => { this._pingRtt = rtt })
      if (this._ctl !== null && this._rtt() === null) this._ctl.ping()
      this._openedAt = Date.now()
      this._lastError = null
      this._startStatusTimer()
      this._emitStatus()
      for (const waiter of [...this._waiters]) waiter(true)
      const pending = this._pending
      this._pending = []
      for (const entry of pending) {
        clearTimeout(entry.timer)
        entry.socket.off('close', entry.onclose)
        this._pipe(entry.socket, entry.opts)
      }
    })
    conn.on('error', (err) => {
      this._lastError = errorText(err)
    })
    conn.on('close', () => {
      if (this._dialing === conn) this._dialing = null
      const wasOpen = this._conn === conn
      if (wasOpen) {
        this._conn = null
        this._mux = null
        this._ctl = null
        this._pingRtt = null
        if (this._probeTimer !== null) {
          clearTimeout(this._probeTimer)
          this._probeTimer = null
        }
        if (Date.now() - this._openedAt >= STABLE_AFTER) this._backoff = BACKOFF_MIN
        if (this._lastError === null) this._lastError = 'CONNECTION_CLOSED'
      }
      this._stopStatusTimer()
      this._emitStatus()
      // Someone is waiting: dial again at once (at most once a second); otherwise
      // keep the link alive with the backoff.
      if (this._pending.length > 0 || this._waiters.size > 0) this._ensure(true)
      else this._scheduleRetry()
    })
  }

  _scheduleRetry () {
    if (this._closing || this._retryTimer !== null || this._conn !== null || this._dialing !== null) return
    const delay = this._backoff
    this._backoff = Math.min(this._backoff * 2, BACKOFF_MAX)
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null
      this._dial()
    }, delay)
  }

  _startStatusTimer () {
    if (this._statusTimer !== null) return
    this._ticks = 0
    // Periodic status while connected, so the UI sees a fresh rtt; a ping now and
    // then when the raw stream has no round trip to report.
    this._statusTimer = setInterval(() => {
      this._ticks++
      const raw = this._conn !== null && this._conn.rawStream ? this._conn.rawStream.rtt : undefined
      if (this._ctl !== null && !(typeof raw === 'number' && raw > 0) && this._ticks % PING_EVERY_TICKS === 0) this._ctl.ping()
      this._emitStatus(true)
    }, STATUS_INTERVAL)
    if (typeof this._statusTimer.unref === 'function') this._statusTimer.unref()
  }

  _stopStatusTimer () {
    if (this._statusTimer === null) return
    clearInterval(this._statusTimer)
    this._statusTimer = null
  }

  // Open and not already being torn down (its 'close' may still be pending).
  _linkUsable () {
    return this._mux !== null && this._conn !== null && !this._conn.destroying && !this._conn.destroyed
  }

  /**
   * Forward one local TCP socket (paused, no other 'data' listener) to the source.
   * @param {object} socket
   * @param {object} [opts]
   * @param {Uint8Array} [opts.head]  bytes to send first (already read from the socket)
   * @param {(n: number) => void} [opts.ondata]  per response chunk
   * @param {number} [opts.timeout=30000]  how long to wait for a down link
   */
  forward (socket, { head = null, ondata = null, timeout = PENDING_TIMEOUT } = {}) {
    socket.on('error', () => {}) // the pipe handles errors once attached; until then just close
    if (this._closing) {
      socket.destroy()
      return
    }
    if (typeof socket.setNoDelay === 'function') socket.setNoDelay(true)
    const opts = { head, ondata }
    if (this._linkUsable()) {
      this._pipe(socket, opts)
      return
    }
    if (this._pending.length >= MAX_PENDING) {
      socket.destroy()
      return
    }
    // Link down: hold the socket (not reading it) until the link is up.
    socket.pause()
    const entry = { socket, opts, timer: null, onclose: null }
    entry.onclose = () => {
      clearTimeout(entry.timer)
      const i = this._pending.indexOf(entry)
      if (i !== -1) this._pending.splice(i, 1)
    }
    entry.timer = setTimeout(() => socket.destroy(), timeout)
    socket.on('close', entry.onclose)
    this._pending.push(entry)
    this._ensure(true)
  }

  _pipe (socket, opts = {}) {
    // Channel ids are 4 random bytes; on the (very unlikely) clash with an open
    // channel createChannel returns null, so try another id.
    for (let attempt = 0; attempt < 3; attempt++) {
      const channel = pipeSocket(this._mux, socket, { id: hcrypto.randomBytes(4), stats: this.stats.pipes, head: opts.head || null, ondata: opts.ondata || null })
      if (channel !== null) return
    }
    socket.destroy()
  }

  /** A raw byte stream to the source's HTTP port (streamx Duplex). */
  async openStream ({ timeout = STREAM_WAIT } = {}) {
    if (this._closing) throw linkError('CLOSED', 'Collegamento chiuso')
    if (!this._linkUsable()) {
      const ok = await this.waitConnected(timeout)
      if (!ok || !this._linkUsable()) throw linkError('UNREACHABLE', 'Fonte non raggiungibile', this._lastError)
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      // The window this link's round trip needs (stream.js): a skip throws away that much at most.
      const stream = channelStream(this._mux, { id: hcrypto.randomBytes(4), stats: this.stats.pipes, window: windowFor(this._rtt()) })
      if (stream !== null) return stream
    }
    throw linkError('UNREACHABLE', 'Fonte non raggiungibile', 'CHANNEL_FAILED')
  }

  /**
   * A small HTTP/1.1 request to the source over its own channel.
   * @returns {Promise<{ status: number, headers: object, body: Uint8Array }>}
   */
  async request (method, path, { headers = {}, body = null, timeout = REQUEST_TIMEOUT } = {}) {
    const started = Date.now()
    const { head, payload } = buildRequest(method, path, headers, body)
    const stream = await this.openStream({ timeout })
    const left = Math.max(1, timeout - (Date.now() - started))
    return new Promise((resolve, reject) => {
      const chunks = []
      let done = false
      const finish = (err, value) => {
        if (done) return
        done = true
        clearTimeout(timer)
        if (err) {
          stream.destroy()
          reject(err)
        } else {
          resolve(value)
        }
      }
      const timer = setTimeout(() => finish(linkError('TIMEOUT', 'Fonte non raggiungibile', 'TIMEOUT')), left)
      stream.on('data', (d) => chunks.push(d))
      stream.on('end', () => {
        let res
        try {
          res = parseResponse(b4a.concat(chunks))
        } catch (err) {
          finish(err)
          return
        }
        stream.end() // our side is done too: the channel closes
        finish(null, res)
      })
      stream.on('error', (err) => finish(linkError('UNREACHABLE', 'Fonte non raggiungibile', errorText(err))))
      stream.on('close', () => finish(linkError('UNREACHABLE', 'Fonte non raggiungibile', 'CHANNEL_CLOSED')))
      // The request is not half-closed: the source answers and closes (Connection:
      // close), then we end our side.
      stream.write(head)
      if (payload !== null && payload.byteLength > 0) stream.write(payload)
    })
  }

  /** Local raw proxy: every accepted socket is forwarded (tests and development). */
  listen ({ port = 0, host = '127.0.0.1' } = {}) {
    if (this._tcp !== null) return Promise.resolve({ host: this.host, port: this.port })
    this.host = host
    this.port = port
    const tcp = net.createServer({ allowHalfOpen: true }, (socket) => this.forward(socket))
    this._tcp = tcp
    return new Promise((resolve, reject) => {
      const onerror = (err) => {
        this._tcp = null
        reject(err)
      }
      tcp.once('error', onerror)
      tcp.listen(port, host, () => {
        tcp.off('error', onerror)
        tcp.on('error', (err) => { this._lastError = errorText(err) })
        const addr = tcp.address()
        if (addr && typeof addr.port === 'number') this.port = addr.port
        resolve({ host: this.host, port: this.port })
      })
    })
  }

  async close () {
    if (this._closing) return
    this._closing = true
    this._dht.off('network-change', this._onnetworkchange)
    if (this._retryTimer !== null) clearTimeout(this._retryTimer)
    if (this._probeTimer !== null) clearTimeout(this._probeTimer)
    this._stopStatusTimer()
    this._retryTimer = this._probeTimer = null
    for (const waiter of [...this._waiters]) waiter(false)
    for (const entry of this._pending) {
      clearTimeout(entry.timer)
      entry.socket.destroy()
    }
    this._pending = []
    const closing = []
    if (this._tcp !== null) {
      const tcp = this._tcp
      this._tcp = null
      closing.push(new Promise((resolve) => tcp.close(() => resolve())))
    }
    if (this._conn !== null) this._conn.destroy()
    if (this._dialing !== null) this._dialing.destroy()
    this._conn = this._dialing = this._mux = this._ctl = null
    await Promise.all(closing)
    if (this._ownDht) await this._dht.destroy()
  }
}

// ------------------------------------------------------------------ pairing

/**
 * Pair with a source through its permanent pairing code.
 * @returns {Promise<{ serverPublicKey: string, name: string }>}
 */
export async function pair (code, { keyPair, name = '', dht = null, bootstrap, timeout = 30000 } = {}) {
  const secret = parseCode(code) // throws INVALID_CODE before any network use
  const kp = toKeyPair(keyPair)
  const pairKeyPair = DHT.keyPair(pairSeedFromSecret(secret))
  const authKey = authKeyFromSecret(secret)
  const nameMessage = encodeName(name)
  const ownDht = dht === null
  const node = dht || createDht({ bootstrap })
  const deadline = Date.now() + timeout
  let lastError = null
  try {
    // Retry while time remains: the source may be announcing again (it just
    // started, or the network changed). Once a connection opened, the answer is final.
    while (true) {
      const left = deadline - Date.now()
      if (left <= 0) break
      const result = await pairOnce(node, pairKeyPair.publicKey, kp, authKey, nameMessage, left)
      if (result.ok) return { serverPublicKey: b4a.toString(result.serverPublicKey, 'hex'), name: result.name }
      lastError = result.error
      if (result.opened) throw linkError('REFUSED', 'Abbinamento rifiutato', lastError)
      if (deadline - Date.now() < 2000) break
      await new Promise((resolve) => setTimeout(resolve, 1500))
    }
    throw linkError('UNREACHABLE', 'Fonte non raggiungibile', lastError || 'TIMEOUT')
  } finally {
    if (ownDht) await node.destroy()
  }
}

function pairOnce (node, pairPublicKey, keyPair, authKey, nameMessage, timeout) {
  return new Promise((resolve) => {
    let conn
    try {
      conn = node.connect(pairPublicKey, { keyPair })
    } catch (err) {
      resolve({ ok: false, opened: false, error: errorText(err) })
      return
    }
    let opened = false
    let result = null
    let lastError = null
    let received = b4a.alloc(0)
    const timer = setTimeout(() => {
      lastError = 'TIMEOUT'
      conn.destroy()
    }, timeout)
    // The source admits nobody on the pairing key alone (DHT nodes see that key):
    // first the proof, bound to this connection's handshake, then our name.
    conn.on('open', () => {
      opened = true
      try {
        conn.write(b4a.concat([pairProof(authKey, conn.handshakeHash), nameMessage]))
      } catch (err) {
        lastError = errorText(err)
        conn.destroy()
      }
    })
    conn.on('data', (data) => {
      if (result !== null) return
      received = b4a.concat([received, data])
      if (received[0] !== 1) {
        lastError = 'BAD_ANSWER'
        conn.destroy()
        return
      }
      // 0x01, the 32-byte main public key, a u8 length and the source name.
      if (received.byteLength < 34) return
      const len = received[33]
      if (len > MAX_NAME_BYTES) {
        lastError = 'BAD_ANSWER'
        conn.destroy()
        return
      }
      if (received.byteLength < 34 + len) return
      result = {
        serverPublicKey: b4a.from(received.subarray(1, 33)),
        name: decodeName(received.subarray(34, 34 + len), '')
      }
      conn.end()
    })
    conn.on('end', () => conn.end())
    conn.on('error', (err) => { lastError = errorText(err) })
    conn.on('close', () => {
      clearTimeout(timer)
      if (result !== null) resolve({ ok: true, ...result })
      else resolve({ ok: false, opened, error: lastError || (opened ? 'CLOSED_WITHOUT_ANSWER' : 'CONNECTION_FAILED') })
    })
  })
}

// --------------------------------------------------------------- HTTP helpers

const TOKEN_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
// The head goes out as Latin-1 (one byte per character): a path is printable ASCII
// only (anything else must be percent-encoded, as Node's http.request demands), a
// header value HTAB, SP, visible ASCII or Latin-1 (RFC 9110 field-value). A wider
// character would lose its high byte on the wire and arrive as another one.
const PATH_BAD_RE = /[^\x21-\x7e]/
const HEADER_VALUE_BAD_RE = /[^\t\x20-\x7e\x80-\xff]/

function buildRequest (method, path, headers, body) {
  if (!TOKEN_RE.test(String(method))) throw new Error('metodo non valido')
  if (typeof path !== 'string' || !path.startsWith('/')) throw new Error('percorso non valido')
  if (PATH_BAD_RE.test(path)) throw new Error('percorso non valido: spazi e caratteri non ASCII vanno codificati (encodeURIComponent)')
  let payload = null
  const extra = {}
  if (body !== null && body !== undefined) {
    if (typeof body === 'string') {
      payload = b4a.from(body, 'utf8')
    } else if (body.byteLength !== undefined) {
      payload = body
    } else {
      payload = b4a.from(JSON.stringify(body), 'utf8')
      extra['Content-Type'] = 'application/json'
    }
  }
  let head = method + ' ' + path + ' HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n'
  const skip = new Set(['host', 'connection', 'content-length', 'transfer-encoding'])
  const all = { ...extra, ...headers }
  for (const [name, value] of Object.entries(all)) {
    if (skip.has(name.toLowerCase())) continue
    if (!TOKEN_RE.test(name) || HEADER_VALUE_BAD_RE.test(String(value))) throw new Error('intestazione non valida: ' + name)
    head += name + ': ' + value + '\r\n'
  }
  if (payload !== null || method === 'POST' || method === 'PUT' || method === 'PATCH') {
    head += 'Content-Length: ' + (payload === null ? 0 : payload.byteLength) + '\r\n'
  }
  head += '\r\n'
  return { head: b4a.from(head, 'latin1'), payload }
}

function indexOfCrlfCrlf (buf) {
  for (let i = 0; i + 3 < buf.byteLength; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) return i
  }
  return -1
}

/** Parse a complete HTTP/1.1 response (the connection was closed after it). */
export function parseResponse (buf) {
  const end = indexOfCrlfCrlf(buf)
  if (end === -1) throw linkError('BAD_RESPONSE', 'Risposta non valida dalla fonte')
  const lines = b4a.toString(buf.subarray(0, end), 'latin1').split('\r\n')
  const m = /^HTTP\/1\.[01] (\d{3})/.exec(lines[0])
  if (m === null) throw linkError('BAD_RESPONSE', 'Risposta non valida dalla fonte')
  const headers = {}
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
  }
  let body = buf.subarray(end + 4)
  if (/chunked/i.test(headers['transfer-encoding'] || '')) {
    body = dechunk(body)
  } else if (headers['content-length'] !== undefined) {
    const n = Number(headers['content-length'])
    if (Number.isInteger(n) && n >= 0 && n <= body.byteLength) body = body.subarray(0, n)
  }
  return { status: Number(m[1]), headers, body }
}

function dechunk (buf) {
  const parts = []
  let at = 0
  while (at < buf.byteLength) {
    let eol = -1
    for (let i = at; i + 1 < buf.byteLength; i++) {
      if (buf[i] === 13 && buf[i + 1] === 10) {
        eol = i
        break
      }
    }
    if (eol === -1) break
    const size = parseInt(b4a.toString(buf.subarray(at, eol), 'latin1'), 16)
    if (!Number.isFinite(size) || size <= 0) break
    parts.push(buf.subarray(eol + 2, eol + 2 + size))
    at = eol + 2 + size + 2
  }
  return b4a.concat(parts)
}
