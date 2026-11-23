// Server side of the MPfy P2P link (runs on every source, e.g. the Mi A2).
//
// - Main listener: a HyperDHT server on the key pair derived from the persistent
//   seed (keys.json). Its firewall rejects every remote public key the host does
//   not admit (clients.json).
// - Each admitted connection carries a protomux: the client opens one "mpfy/tcp/1"
//   channel per request it forwards, and every channel becomes a TCP connection to
//   the HTTP port on 127.0.0.1 (never the admin port), opened from 127.0.0.2 so
//   the HTTP server tells a forwarded request from a local one by its address,
//   never by a missing mapping. For each such socket the
//   server remembers its local port and the remote public key of the connection
//   that opened it (clientForPort), so the HTTP server can tell who is asking. A
//   "mpfy/ctl/1" channel answers pings (control.js).
// - Pairing: a second HyperDHT server, ALWAYS listening, on the key pair
//   derived from the permanent pairing secret, with no allow-list. Its public key
//   is not a secret (DHT nodes see it), so a connection must first send a proof
//   bound to its handshake (code.js). Then the client's name (u8 length + UTF-8);
//   the server admits the client's key through `onPaired`, answers 0x01, its main
//   public key (32 bytes) and its name (u8 length + UTF-8), and ends. A bad or
//   missing proof admits nothing. Rate limits: failed proofs per remote key and in
//   all per 10 minutes, and a bound on connections waiting for their proof.
//   setPairingSecret() rotates: the old code stops admitting at once; a failed
//   listen on the new key is retried by itself ('pairing-error', 'pairing-listening').
//
// No Node-only module here except through the '#net' import map (bare-tcp on Bare).

import DHT from 'hyperdht'
import Protomux from 'protomux'
import b4a from 'b4a'
import net from '#net'
import { Emitter } from './emitter.js'
import { pipeSocket, newPipeStats, PROTOCOL } from './pipe.js'
import { serveControl } from './control.js'
import {
  toKey, errorText, checkPairProof, pairSeedFromSecret, authKeyFromSecret,
  encodeName, decodeName, PAIR_PROOF_BYTES, MAX_NAME_BYTES, SECRET_BYTES
} from './code.js'

// A pairing connection must send its proof (and its name) within this time.
const PAIR_PROOF_TIMEOUT = 15000
// A pairing listen that failed after a rotation is tried again this often.
const PAIRING_RETRY = 30000
// No data for this long (HyperDHT sends keep-alives every 5 s) means the link is dead.
const LINK_TIMEOUT = 20000
const MAX_CHANNELS_PER_CONNECTION = 512
export const DEFAULT_DEVICE_NAME = 'Dispositivo'

export const PAIR_LIMITS = Object.freeze({
  perKey: 5, // failed proofs per remote key per window
  total: 30, // failed proofs in all per window
  windowMs: 10 * 60 * 1000,
  maxPending: 8 // connections waiting for their proof
})

/**
 * Sliding-window counter of failed pairing proofs. Memory stays bounded: once the
 * total limit is reached every attempt is refused before it can fail, and entries
 * older than the window are dropped on every access.
 */
export class PairLimiter {
  constructor ({ perKey = PAIR_LIMITS.perKey, total = PAIR_LIMITS.total, windowMs = PAIR_LIMITS.windowMs, now = Date.now } = {}) {
    this.perKey = perKey
    this.total = total
    this.windowMs = windowMs
    this._now = now
    this._all = [] // failure times, oldest first
    this._byKey = new Map() // hex -> failure times, oldest first
  }

  _prune () {
    const limit = this._now() - this.windowMs
    while (this._all.length > 0 && this._all[0] <= limit) this._all.shift()
    for (const [key, list] of this._byKey) {
      while (list.length > 0 && list[0] <= limit) list.shift()
      if (list.length === 0) this._byKey.delete(key)
    }
  }

  /** May this remote key try a proof now? */
  allowed (hex) {
    this._prune()
    if (this._all.length >= this.total) return false
    const list = this._byKey.get(hex)
    return list === undefined || list.length < this.perKey
  }

  fail (hex) {
    this._prune()
    const t = this._now()
    this._all.push(t)
    const list = this._byKey.get(hex)
    if (list === undefined) this._byKey.set(hex, [t])
    else list.push(t)
  }

  info () {
    this._prune()
    return { failures: this._all.length, keys: this._byKey.size }
  }
}

export class MPfyTransportServer extends Emitter {
  /**
   * @param {object} opts
   * @param {Uint8Array|string} opts.seed  32-byte seed of the server key pair (keys.json)
   * @param {(publicKeyHex: string) => boolean|Promise<boolean>} opts.isAllowed
   * @param {(publicKeyHex: string, name: string) => void|Promise<void>} opts.onPaired
   * @param {Uint8Array} [opts.pairingSecret]  20-byte permanent pairing secret
   * @param {string|(() => string)} [opts.sourceName]  name sent to paired clients
   * @param {number} [opts.targetPort=8091]  local HTTP port the channels connect to
   * @param {string} [opts.targetHost='127.0.0.1']
   * @param {string|null} [opts.targetLocalAddress='127.0.0.2']  where the channels' sockets come from
   * @param {object} [opts.dht]  an existing HyperDHT instance (otherwise one is created)
   * @param {Array} [opts.bootstrap]  DHT bootstrap nodes (default: the public DHT)
   * @param {number} [opts.pairProofTimeout]
   * @param {number} [opts.pairingRetryMs]  retry period of a failed pairing listen after a rotation
   * @param {object} [opts.pairLimits]  { perKey, total, windowMs, maxPending }
   */
  constructor ({
    seed, isAllowed, onPaired, pairingSecret = null, sourceName = '', targetPort = 8091, targetHost = '127.0.0.1', targetLocalAddress = '127.0.0.2',
    dht = null, bootstrap, linkTimeout = LINK_TIMEOUT, pairProofTimeout = PAIR_PROOF_TIMEOUT, pairingRetryMs = PAIRING_RETRY,
    pairLimits = {}
  } = {}) {
    super()
    if (typeof isAllowed !== 'function') throw new Error('isAllowed is required')
    if (typeof onPaired !== 'function') throw new Error('onPaired is required')
    this.keyPair = DHT.keyPair(toKey(seed, 'seed'))
    this.targetPort = targetPort
    this.targetHost = targetHost
    this.targetLocalAddress = targetLocalAddress
    this.linkTimeout = linkTimeout
    this.pairProofTimeout = pairProofTimeout
    this.pairingRetryMs = pairingRetryMs
    const limits = { ...PAIR_LIMITS, ...pairLimits }
    this.maxPairPending = limits.maxPending
    this.limiter = new PairLimiter(limits)
    // pairRefused: pairing connections dropped for a missing or wrong proof;
    // pairRejected: pairing connections refused up front (rate limits, rotation).
    this.stats = { accepted: 0, rejected: 0, paired: 0, pairRefused: 0, pairRejected: 0, pipes: newPipeStats() }

    this._isAllowed = isAllowed
    this._onPaired = onPaired
    this._sourceName = sourceName
    this._ownDht = dht === null
    this._dht = dht || new DHT(bootstrap ? { bootstrap } : {})
    this._server = null
    this._connections = new Map() // publicKeyHex -> Set of connection entries
    this._ports = new Map() // local port of a socket to the HTTP port -> { publicKey, socket }
    this._pairingSecret = pairingSecret ? checkSecret(pairingSecret) : null
    this._pairing = null // the listening pairing session
    this._pairingGen = 0
    this._pairingRetry = null // timer of the next pairing listen after a failed one
    this._closing = false
  }

  get publicKey () {
    return this.keyPair.publicKey
  }

  get dht () {
    return this._dht
  }

  get closing () {
    return this._closing
  }

  /** Public key of the pairing listener (hex), or null. Not a secret. */
  get pairingPublicKey () {
    if (this._pairingSecret === null) return null
    return b4a.toString(DHT.keyPair(pairSeedFromSecret(this._pairingSecret)).publicKey, 'hex')
  }

  /** Start both listeners (main and pairing). Safe to call again after a failure. */
  async listen () {
    if (this._closing) throw new Error('server closing')
    if (this._server === null) {
      const server = this._dht.createServer({
        firewall: async (remotePublicKey) => {
          let allowed = false
          try {
            allowed = !!(await this._isAllowed(b4a.toString(remotePublicKey, 'hex')))
          } catch {
            allowed = false
          }
          if (!allowed) this.stats.rejected++
          return !allowed // true means "reject"
        }
      }, (conn) => this._onconnection(conn))
      this._server = server
      try {
        await server.listen(this.keyPair)
      } catch (err) {
        // Leave no half-started server behind, so listen() can be retried.
        this._server = null
        server.close().catch(() => {})
        throw err
      }
    }
    if (this._pairingSecret !== null && this._pairing === null) await this._listenPairing()
  }

  get listening () {
    return this._server !== null && !this._closing
  }

  // ------------------------------------------------------------ connections

  _onconnection (conn) {
    if (this._closing) {
      conn.destroy()
      return
    }
    this.stats.accepted++
    const hex = b4a.toString(conn.remotePublicKey, 'hex')
    const entry = { conn, publicKey: hex, channels: 0, revoked: false, onidle: null }
    let set = this._connections.get(hex)
    if (!set) {
      set = new Set()
      this._connections.set(hex, set)
    }
    set.add(entry)
    conn.setTimeout(this.linkTimeout)
    conn.on('error', (err) => this.emit('connection-error', { publicKey: hex, error: errorText(err) }))
    conn.on('close', () => {
      set.delete(entry)
      if (set.size === 0 && this._connections.get(hex) === set) this._connections.delete(hex)
      this.emit('disconnect', { publicKey: hex })
    })

    const mux = Protomux.from(conn)
    serveControl(mux)
    serveMux(mux, {
      connect: () => this._connectTarget(hex),
      stats: this.stats.pipes,
      accept: () => !this._closing && !entry.revoked,
      onopen: () => { entry.channels++ },
      onclose: () => {
        entry.channels--
        if (entry.channels === 0 && entry.onidle !== null) entry.onidle()
      }
    })
    this.emit('connect', { publicKey: hex })
  }

  // A TCP connection to the HTTP port for a channel of `hex`'s connection; its
  // local port maps back to `hex` for as long as it is open.
  _connectTarget (hex) {
    const opts = { port: this.targetPort, host: this.targetHost, allowHalfOpen: true }
    if (this.targetLocalAddress) opts.localAddress = this.targetLocalAddress
    const socket = net.createConnection(opts)
    let port = null
    socket.on('connect', () => {
      port = typeof socket.localPort === 'number' ? socket.localPort : (socket.address && socket.address().port)
      if (typeof port === 'number') this._ports.set(port, { publicKey: hex, socket })
    })
    socket.on('close', () => {
      if (port !== null) {
        const e = this._ports.get(port)
        if (e && e.socket === socket) this._ports.delete(port)
      }
    })
    return socket
  }

  /**
   * Which client opened the TCP connection whose LOCAL port is `port` (seen by the
   * HTTP server as req.socket.remotePort)? Hex public key, or null for a request
   * that did not come through P2P.
   */
  clientForPort (port) {
    const e = this._ports.get(port)
    return e ? e.publicKey : null
  }

  /** Every open channel's TCP socket to the HTTP port: [{ localPort, publicKey }]. */
  channels () {
    return [...this._ports].map(([localPort, e]) => ({ localPort, publicKey: e.publicKey }))
  }

  /**
   * Close every live connection of a client (after it was removed from
   * clients.json). With graceMs, a connection still carrying channels (the
   * request that asked for this, typically) is closed when they are done, or after
   * graceMs; no new channel is accepted on it meanwhile.
   */
  dropClient (publicKeyHex, { graceMs = 0 } = {}) {
    const set = this._connections.get(String(publicKeyHex).toLowerCase())
    if (!set) return 0
    let n = 0
    for (const entry of [...set]) {
      n++
      entry.revoked = true
      if (graceMs <= 0 || entry.channels === 0) {
        entry.conn.destroy()
        continue
      }
      const timer = setTimeout(() => entry.conn.destroy(), graceMs)
      entry.onidle = () => {
        clearTimeout(timer)
        // Let the last bytes of the closing channel leave before the stream goes.
        setTimeout(() => entry.conn.destroy(), 50)
      }
      entry.conn.on('close', () => clearTimeout(timer))
    }
    return n
  }

  connectedClients () {
    return [...this._connections.keys()]
  }

  // ---------------------------------------------------------------- pairing

  /**
   * Replace the pairing secret (rotation). The current pairing listener stops
   * admitting at once; a new one listens on the new key pair. Resolves when it
   * listens (or at once when the main listener is not up yet: listen() will).
   * Rejects when that listen fails, and then keeps retrying by itself every
   * pairingRetryMs until it listens (the old listener is gone already, and nobody
   * else would try again before the next rotation).
   */
  async setPairingSecret (secret) {
    this._pairingSecret = checkSecret(secret)
    this._closePairing()
    if (this._server !== null && !this._closing) await this._listenPairingOrRetry()
  }

  async _listenPairingOrRetry () {
    try {
      await this._listenPairing()
    } catch (err) {
      this._retryPairingLater()
      throw err
    }
  }

  _retryPairingLater () {
    if (this._pairingRetry !== null || this._closing) return
    this._pairingRetry = setTimeout(() => {
      this._pairingRetry = null
      // Listening again already (a newer rotation, or listen()), or nothing to do.
      if (this._closing || this._server === null || this._pairing !== null || this._pairingSecret === null) return
      this._listenPairingOrRetry().then(
        () => { if (this._pairing !== null) this.emit('pairing-listening', { publicKey: this.pairingPublicKey }) },
        (err) => this.emit('pairing-error', { error: errorText(err), retryMs: this.pairingRetryMs })
      )
    }, this.pairingRetryMs)
  }

  async _listenPairing () {
    const secret = this._pairingSecret
    const gen = ++this._pairingGen
    const session = {
      gen,
      authKey: authKeyFromSecret(secret),
      keyPair: DHT.keyPair(pairSeedFromSecret(secret)),
      server: null,
      pending: 0,
      closed: false
    }
    session.server = this._dht.createServer({
      firewall: (remotePublicKey) => {
        const reject = session.closed || this._closing || session.pending >= this.maxPairPending ||
          !this.limiter.allowed(b4a.toString(remotePublicKey, 'hex'))
        if (reject) this.stats.pairRejected++
        return reject
      }
    }, (conn) => this._onpair(session, conn))
    this._pairing = session
    try {
      await session.server.listen(session.keyPair)
    } catch (err) {
      const superseded = session.closed // rotated or closed meanwhile: not a failure
      if (this._pairing === session) this._pairing = null
      session.closed = true
      session.server.close().catch(() => {})
      if (!superseded) throw err
    }
  }

  _closePairing () {
    const session = this._pairing
    this._pairing = null
    if (session === null) return
    session.closed = true
    session.server.close().catch(() => {})
  }

  _sourceNameNow () {
    const n = typeof this._sourceName === 'function' ? this._sourceName() : this._sourceName
    return String(n || '')
  }

  _onpair (session, conn) {
    conn.on('error', () => {})
    const hex = b4a.toString(conn.remotePublicKey, 'hex')
    if (session.closed || this._closing || session.pending >= this.maxPairPending || !this.limiter.allowed(hex)) {
      this.stats.pairRejected++
      conn.destroy()
      return
    }
    // Nothing is admitted on connect: first PAIR_PROOF_BYTES of proof, then the
    // name (u8 length + UTF-8). Exactly that and nothing more.
    session.pending++
    let waiting = true
    let received = b4a.alloc(0)
    let proved = false
    const stopWaiting = () => {
      if (!waiting) return false
      waiting = false
      session.pending--
      clearTimeout(timer)
      return true
    }
    const refuse = () => {
      // A failed (wrong or missing) proof: counted for the rate limits.
      this.limiter.fail(hex)
      this.stats.pairRefused++
      this.emit('pair-refused', { publicKey: hex })
      conn.destroy()
    }
    const giveUp = () => {
      // Proof good but the rest broken or late: admit nothing, not a failed proof.
      conn.destroy()
    }
    const timer = setTimeout(() => {
      if (stopWaiting()) (proved ? giveUp : refuse)()
    }, this.pairProofTimeout)
    // Hung up before a complete message, gracefully ('end') or not ('close' with no
    // 'end': destroy(), a lost link). Both count as a failed proof: otherwise a
    // stranger could fill every waiting slot, drop each connection just before the
    // timeout, and block real pairings without ever being counted. A connection the
    // source itself cut (rotation, shutdown) is not the peer's failure.
    const hungUp = () => {
      if (!stopWaiting()) return
      if (proved || session.closed || this._closing) giveUp()
      else refuse()
    }
    conn.on('end', hungUp)
    conn.on('close', hungUp)
    conn.on('data', (data) => {
      if (!waiting) return // after the name the client only waits for the answer
      received = b4a.concat([received, data])
      if (!proved) {
        if (received.byteLength < PAIR_PROOF_BYTES) return
        const proof = received.subarray(0, PAIR_PROOF_BYTES)
        if (session.closed || !checkPairProof(session.authKey, conn.handshakeHash, proof)) {
          stopWaiting()
          if (session.closed) {
            this.stats.pairRejected++
            conn.destroy()
          } else {
            refuse()
          }
          return
        }
        proved = true
        received = received.subarray(PAIR_PROOF_BYTES)
      }
      if (received.byteLength < 1) return
      const len = received[0]
      if (len > MAX_NAME_BYTES || received.byteLength > 1 + len) {
        stopWaiting()
        giveUp()
        return
      }
      if (received.byteLength < 1 + len) return
      stopWaiting()
      if (session.closed || this._closing) {
        conn.destroy()
        return
      }
      this._admitPaired(conn, hex, decodeName(received.subarray(1, 1 + len), DEFAULT_DEVICE_NAME))
    })
  }

  _admitPaired (conn, hex, name) {
    const fallback = setTimeout(() => conn.destroy(), 30000)
    conn.on('close', () => clearTimeout(fallback))
    Promise.resolve()
      .then(() => this._onPaired(hex, name))
      .then(() => {
        this.stats.paired++
        const answer = b4a.concat([b4a.from([1]), this.keyPair.publicKey, encodeName(this._sourceNameNow())])
        conn.write(answer)
        conn.end()
        this.emit('paired', { publicKey: hex, name })
      }, (err) => {
        this.emit('pair-error', { error: errorText(err) })
        conn.destroy()
      })
  }

  pairingInfo () {
    const s = this._pairing
    return {
      listening: s !== null && !s.closed,
      publicKey: this.pairingPublicKey,
      limits: this.limiter.info()
    }
  }

  info () {
    let connections = 0
    for (const set of this._connections.values()) connections += set.size
    return {
      publicKey: b4a.toString(this.publicKey, 'hex'),
      connections,
      dht: {
        firewalled: this._dht.firewalled,
        host: this._dht.host,
        port: this._dht.port
      },
      pairing: this.pairingInfo(),
      stats: this.stats
    }
  }

  async close () {
    if (this._closing) return
    this._closing = true
    if (this._pairingRetry !== null) clearTimeout(this._pairingRetry)
    this._pairingRetry = null
    this._closePairing()
    for (const set of this._connections.values()) {
      for (const entry of set) entry.conn.destroy()
    }
    this._connections.clear()
    if (this._server !== null) await this._server.close().catch(() => {})
    if (this._ownDht) await this._dht.destroy()
  }
}

function checkSecret (secret) {
  if (!secret || secret.byteLength !== SECRET_BYTES) throw new Error('pairing secret must be ' + SECRET_BYTES + ' bytes')
  return secret
}

/**
 * Serve the client's channels on one mux: every channel the remote opens becomes a
 * TCP connection made by `connect()` (to 127.0.0.1:<HTTP port> in production).
 * A failing target closes only that channel.
 */
export function serveMux (mux, { connect, stats = null, accept = () => true, maxChannels = MAX_CHANNELS_PER_CONNECTION, onopen = null, onclose = null }) {
  let active = 0
  mux.pair({ protocol: PROTOCOL }, (id) => {
    // Not creating the channel makes protomux reject it.
    if (active >= maxChannels || !accept()) return
    const socket = connect()
    if (typeof socket.setNoDelay === 'function') socket.setNoDelay(true)
    const channel = pipeSocket(mux, socket, {
      id,
      stats,
      onclose: () => {
        active--
        if (onclose !== null) onclose()
      }
    })
    if (channel === null) {
      socket.destroy()
      return
    }
    active++
    if (onopen !== null) onopen()
  })
}
