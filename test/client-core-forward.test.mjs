// A forwarded stream whose reader goes away (a skip): the source stops at once,
// and what it was allowed to send beyond what the reader took is bounded by the
// window the stream needs, not by the transport's whole window. The source is a
// real TCP server behind the server side of the pipe (transport/server.js
// serveMux, pipe.js), joined to the core's side by an in-memory link; the local
// reader is a socket whose room the test controls.

import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import net from 'node:net'
import { EventEmitter } from 'node:events'
import Protomux from 'protomux'
import { serveMux } from '../transport/server.js'
import { newPipeStats, WINDOW, MAX_PIECE } from '../transport/pipe.js'
import { channelStream, windowFor, STREAM_WINDOW_MIN } from '../transport/stream.js'
import { MPfyLink } from '../transport/client.js'
import { pipeForward } from '../client-core/forward.js'
import { framedPair, listenServer, closeServer } from './helpers.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const B = (s) => Buffer.from(s, 'latin1')

// A local socket for pipeForward: write() returns false once `room` bytes are
// used; read(n) is the client taking n bytes, with 'drain' when it was full;
// destroy() is the client going away.
class FakeSocket extends EventEmitter {
  constructor () {
    super()
    this.room = Infinity
    this.received = 0
    this.destroyed = false
  }

  write (chunk) {
    if (this.destroyed) return false
    this.received += chunk.byteLength
    this.room -= chunk.byteLength
    return this.room > 0
  }

  read (n) {
    const full = this.room <= 0
    this.room += n
    if (full && this.room > 0) this.emit('drain')
  }

  end () {}
  pause () {}
  resume () {}
  once (name, fn) {
    return super.once(name, fn)
  }

  destroy () {
    if (this.destroyed) return
    this.destroyed = true
    this.emit('close')
  }
}

// A source that answers any request with an endless body, as fast as its socket
// takes it; `sent` counts what it wrote.
async function endlessSource (t) {
  const state = { sent: 0 }
  const sockets = new Set()
  const chunk = crypto.randomBytes(64 * 1024)
  const server = net.createServer({ allowHalfOpen: true }, (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
    s.on('error', () => {})
    s.once('data', () => {
      s.write('HTTP/1.1 200 OK\r\nContent-Type: audio/flac\r\nConnection: close\r\n\r\n')
      const pump = () => {
        while (!s.destroyed) {
          state.sent += chunk.length
          if (!s.write(chunk)) return s.once('drain', pump)
        }
      }
      pump()
    })
  })
  const port = await listenServer(server)
  t.after(async () => {
    for (const s of sockets) s.destroy()
    await closeServer(server)
  })
  return { port, state }
}

async function linkTo (t, port) {
  const [a, b] = framedPair()
  const clientMux = new Protomux(a)
  const serverStats = newPipeStats()
  serveMux(new Protomux(b), { connect: () => net.createConnection({ port, host: '127.0.0.1', allowHalfOpen: true }), stats: serverStats })
  t.after(() => a.destroy())
  return { clientMux, serverStats }
}

const HEAD = B('GET /api/stream/aaaaaaaaaaaaaaaaaaaaaaaa?q=max HTTP/1.1\r\nHost: 127.0.0.1:8091\r\nConnection: close\r\n\r\n')

// Until `fn` holds, or fail after `ms`.
async function until (fn, what, ms = 5000) {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out waiting for ' + what)
    await sleep(5)
  }
}

test('a skip: the player held 50 s of music and goes away; the source sent at most the stream\'s window beyond what the player took, and nothing after', async (t) => {
  const src = await endlessSource(t)
  const link = await linkTo(t, src.port)
  const window = STREAM_WINDOW_MIN
  const stream = channelStream(link.clientMux, { id: crypto.randomBytes(4), window })
  const socket = new FakeSocket()
  pipeForward({ socket, stream, head: HEAD, rest: B(''), req: { body: 'none' }, flow: null })

  // The player fills its buffer at the link's speed.
  await until(() => socket.received >= 3 * 1024 * 1024, 'the first 3 MB')
  // Full: it reads at the playback pace now (a 1,411 kbps FLAC: 176 KB a second).
  socket.room = 0
  for (let i = 0; i < 10; i++) {
    await sleep(50)
    socket.read(8820)
  }
  await sleep(200)
  const sentBySource = link.serverStats.bytesOut
  const held = sentBySource - socket.received
  t.diagnostic('sent by the source beyond what the player took: ' + held + ' bytes (window ' + window + ')')
  assert.ok(held <= window + MAX_PIECE, 'beyond what the player took, at most the window and one piece: ' + held)

  // The skip.
  socket.destroy()
  await sleep(300)
  const after = link.serverStats.bytesOut - sentBySource
  assert.ok(after <= MAX_PIECE, 'the source stops at once: ' + after + ' bytes after the skip')
  assert.equal(link.serverStats.closed, link.serverStats.opened, 'the channel on the source is closed')
})

test('a skip while the player reads at full speed: the forwarded request ends at once, the source stops', async (t) => {
  const src = await endlessSource(t)
  const link = await linkTo(t, src.port)
  const stream = channelStream(link.clientMux, { id: crypto.randomBytes(4), window: STREAM_WINDOW_MIN })
  const socket = new FakeSocket()
  pipeForward({ socket, stream, head: HEAD, rest: B(''), req: { body: 'none' }, flow: null })
  await until(() => socket.received >= 2 * 1024 * 1024, 'the first 2 MB')
  socket.destroy()
  const at = link.serverStats.bytesOut
  await sleep(500)
  const after = link.serverStats.bytesOut - at
  assert.ok(after <= STREAM_WINDOW_MIN + MAX_PIECE, 'what was in flight at most: ' + after)
  await until(() => link.serverStats.closed === link.serverStats.opened, 'the channel closed on the source')
})

test('the window of a stream follows the link\'s round trip: 128 KB on a near link, the whole window when the round trip is unknown or long', () => {
  assert.equal(windowFor(null), WINDOW)
  assert.equal(windowFor(undefined), WINDOW)
  assert.equal(windowFor(0), WINDOW)
  assert.equal(windowFor(5), STREAM_WINDOW_MIN)
  assert.equal(windowFor(15), STREAM_WINDOW_MIN)
  assert.equal(windowFor(16), Math.ceil(8 * 1024 * 1024 * 0.016))
  assert.equal(windowFor(50), Math.ceil(8 * 1024 * 1024 * 0.05))
  assert.equal(windowFor(125), WINDOW)
  assert.equal(windowFor(400), WINDOW)
  for (let rtt = 1; rtt < 300; rtt += 7) {
    const w = windowFor(rtt)
    assert.ok(w >= STREAM_WINDOW_MIN && w <= WINDOW)
  }
})

test('a link opens its streams with the window of its round trip', async (t) => {
  const src = await endlessSource(t)
  const link = await linkTo(t, src.port)
  // The link's own state, without a network: connected through this mux, a near peer.
  const fake = Object.create(MPfyLink.prototype)
  Object.assign(fake, { _closing: false, _mux: link.clientMux, stats: { pipes: newPipeStats() }, _linkUsable: () => true, _rtt: () => 8 })
  const stream = await fake.openStream({ timeout: 100 })
  const socket = new FakeSocket()
  pipeForward({ socket, stream, head: HEAD, rest: B(''), req: { body: 'none' }, flow: null })
  await until(() => socket.received >= 3 * 1024 * 1024, 'the first 3 MB')
  socket.room = 0
  await sleep(300)
  const held = link.serverStats.bytesOut - socket.received
  assert.ok(held <= STREAM_WINDOW_MIN + MAX_PIECE, 'held at most the near link\'s window: ' + held)
  socket.destroy()
})

test('a stream with a small window carries every byte in order, with a reader that pauses', async (t) => {
  const sockets = new Set()
  const echo = net.createServer({ allowHalfOpen: true }, (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
    s.on('error', () => {})
    s.pipe(s)
  })
  const port = await listenServer(echo)
  t.after(async () => {
    for (const s of sockets) s.destroy()
    await closeServer(echo)
  })
  const link = await linkTo(t, port)
  const stream = channelStream(link.clientMux, { id: crypto.randomBytes(4), window: STREAM_WINDOW_MIN })
  const data = crypto.randomBytes(4 * 1024 * 1024)
  const chunks = []
  let pauses = 0
  const done = new Promise((resolve, reject) => {
    stream.on('data', (c) => {
      chunks.push(c)
      if (chunks.length % 8 === 0 && pauses < 4) {
        pauses++
        stream.pause()
        setTimeout(() => stream.resume(), 100)
      }
    })
    stream.on('end', resolve)
    stream.on('error', reject)
  })
  stream.end(data)
  await done
  const back = Buffer.concat(chunks)
  assert.equal(back.length, data.length)
  assert.ok(back.equals(data), 'same bytes in the same order')
  assert.equal(pauses, 4)
})
