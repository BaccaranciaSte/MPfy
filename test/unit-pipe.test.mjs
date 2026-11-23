// The TCP-over-protomux pipe, without a network: two protomux instances joined by
// an in-memory framed stream pair, real local TCP sockets on both ends.

import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import net from 'node:net'
import Protomux from 'protomux'
import c from 'compact-encoding'
import { pipeSocket, newPipeStats, WINDOW, PROTOCOL } from '../transport/pipe.js'
import { serveMux } from '../transport/server.js'
import { framedPair, listenServer, closeServer } from './helpers.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const SLACK = 256 * 1024

// Client mux <-> server mux, a local proxy port on the client side, channels
// served on the server side by connect().
async function makeLink (t, connect) {
  const [a, b] = framedPair()
  const clientMux = new Protomux(a)
  const serverMux = new Protomux(b)
  const clientStats = newPipeStats()
  const serverStats = newPipeStats()
  serveMux(serverMux, { connect, stats: serverStats })
  const sockets = new Set()
  const proxy = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    pipeSocket(clientMux, socket, { id: crypto.randomBytes(4), stats: clientStats })
  })
  const port = await listenServer(proxy)
  t.after(async () => {
    for (const s of sockets) s.destroy()
    a.destroy()
    await closeServer(proxy)
  })
  return { port, a, b, clientMux, clientStats, serverStats }
}

function targetServer (t, onsocket) {
  const sockets = new Set()
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    onsocket(socket)
  })
  t.after(async () => {
    for (const s of sockets) s.destroy()
    await closeServer(server)
  })
  return listenServer(server)
}

const connectTo = (port) => () => net.createConnection({ port, host: '127.0.0.1', allowHalfOpen: true })

function readAll (socket) {
  return new Promise((resolve, reject) => {
    const chunks = []
    socket.on('data', (c) => chunks.push(c))
    socket.on('end', () => resolve(Buffer.concat(chunks)))
    socket.on('error', reject)
  })
}

test('pipe: echo with half-close carries every byte both ways', async (t) => {
  const target = await targetServer(t, (s) => s.pipe(s))
  const link = await makeLink(t, connectTo(target))
  const data = crypto.randomBytes(4 * 1024 * 1024)
  const sock = net.createConnection({ port: link.port, host: '127.0.0.1', allowHalfOpen: true })
  const got = readAll(sock)
  sock.end(data)
  const back = await got
  assert.equal(back.length, data.length)
  assert.ok(back.equals(data))
  sock.destroy()
})

test('pipe: a slow reader on the client holds the server back (download backpressure)', async (t) => {
  const TOTAL = 12 * 1024 * 1024
  const payload = crypto.randomBytes(TOTAL)
  let sent = 0
  const target = await targetServer(t, (s) => {
    const pump = () => {
      while (sent < TOTAL) {
        const chunk = payload.subarray(sent, sent + 64 * 1024)
        sent += chunk.length
        if (!s.write(chunk)) return s.once('drain', pump)
      }
      s.end()
    }
    pump()
  })
  const link = await makeLink(t, connectTo(target))
  const sock = net.createConnection({ port: link.port, host: '127.0.0.1', allowHalfOpen: true })
  const chunks = []
  await new Promise((resolve) => sock.once('data', (c) => {
    chunks.push(c)
    sock.pause()
    resolve()
  }))
  await sleep(1500)
  t.diagnostic('download: sent during pause ' + sent + ', client maxQueued ' + link.clientStats.maxQueued + ', server credit stalls ' + link.serverStats.creditStalls)
  assert.ok(link.clientStats.maxQueued <= WINDOW + SLACK, 'client socket queue bounded: ' + link.clientStats.maxQueued)
  assert.ok(link.serverStats.creditStalls > 0, 'the server side waited for credit')
  const sentDuringPause = sent
  const done = new Promise((resolve) => sock.on('end', resolve))
  sock.on('data', (c) => chunks.push(c))
  sock.resume()
  await done
  const all = Buffer.concat(chunks)
  assert.equal(all.length, TOTAL)
  assert.ok(all.equals(payload))
  assert.ok(sentDuringPause < TOTAL, 'the target was not allowed to finish while the reader slept')
  sock.destroy()
})

test('pipe: a slow reader on the server holds the client back (upload backpressure)', async (t) => {
  const TOTAL = 12 * 1024 * 1024
  const payload = crypto.randomBytes(TOTAL)
  let received = null
  const target = await targetServer(t, (s) => {
    s.pause()
    received = new Promise((resolve) => {
      setTimeout(() => {
        const chunks = []
        s.on('data', (c) => chunks.push(c))
        s.on('end', () => {
          s.end()
          resolve(Buffer.concat(chunks))
        })
        s.resume()
      }, 1500)
    })
  })
  const link = await makeLink(t, connectTo(target))
  const sock = net.createConnection({ port: link.port, host: '127.0.0.1', allowHalfOpen: true })
  sock.end(payload)
  await sleep(1200)
  t.diagnostic('upload: server maxQueued ' + link.serverStats.maxQueued + ', client credit stalls ' + link.clientStats.creditStalls)
  assert.ok(link.serverStats.maxQueued <= WINDOW + SLACK, 'server socket queue bounded: ' + link.serverStats.maxQueued)
  assert.ok(link.clientStats.creditStalls > 0, 'the client side waited for credit')
  while (received === null) await sleep(20)
  const all = await received
  assert.equal(all.length, TOTAL)
  assert.ok(all.equals(payload))
  sock.destroy()
})

test('pipe: a failing target closes only its own channel', async (t) => {
  const echo = await targetServer(t, (s) => s.pipe(s))
  const closedPort = await (async () => {
    const s = net.createServer()
    const p = await listenServer(s)
    await closeServer(s)
    return p
  })()
  let n = 0
  const link = await makeLink(t, () => connectTo(n++ === 0 ? closedPort : echo)())

  const first = net.createConnection({ port: link.port, host: '127.0.0.1' })
  first.on('error', () => {})
  await new Promise((resolve) => first.on('close', resolve))

  const second = net.createConnection({ port: link.port, host: '127.0.0.1', allowHalfOpen: true })
  const got = readAll(second)
  second.end('ciao')
  assert.equal((await got).toString(), 'ciao')
  assert.equal(link.a.destroyed, false, 'the mux survived')
  second.destroy()
})

test('pipe: a malformed credit or end message from the peer closes only its channel', { timeout: 15000 }, async (t) => {
  const echo = await targetServer(t, (s) => s.pipe(s))
  const link = await makeLink(t, connectTo(echo))

  // A peer that does not follow the protocol (a mismatched build): its own channel
  // with every message raw, so it can send truncated numbers.
  async function badChannel (type, payload) {
    const closed = new Promise((resolve) => {
      const ch = link.clientMux.createChannel({
        protocol: PROTOCOL,
        id: crypto.randomBytes(4),
        messages: [{ encoding: c.raw }, { encoding: c.raw }, { encoding: c.raw }],
        onclose: resolve
      })
      ch.open()
      ch.messages[type].send(payload)
    })
    await closed
  }
  await badChannel(1, Buffer.from([0xfd])) // credit: a 16-bit number announced, missing
  assert.equal(link.b.destroyed, false, 'the server side mux survived a truncated credit')
  assert.equal(link.a.destroyed, false, 'the client side mux survived a truncated credit')
  await badChannel(2, Buffer.alloc(0)) // end: no number at all
  assert.equal(link.b.destroyed, false, 'the server side mux survived an empty end')
  assert.equal(link.a.destroyed, false, 'the client side mux survived an empty end')
  assert.ok(link.serverStats.errors >= 2, 'both bad channels counted as errors')
  // And the connection still carries traffic.
  const sock = net.createConnection({ port: link.port, host: '127.0.0.1', allowHalfOpen: true })
  const got = readAll(sock)
  sock.end('ancora vivo')
  assert.equal((await got).toString(), 'ancora vivo')
  sock.destroy()
})

test('pipe: losing the link closes the local sockets', async (t) => {
  const target = await targetServer(t, () => {})
  const link = await makeLink(t, connectTo(target))
  const sock = net.createConnection({ port: link.port, host: '127.0.0.1' })
  sock.on('error', () => {})
  await new Promise((resolve) => sock.on('connect', resolve))
  await sleep(100)
  const closed = new Promise((resolve) => sock.on('close', resolve))
  link.a.destroy()
  await closed
})

test('channel stream: 4 MB written and read back through an echo target, with a reader that pauses', async (t) => {
  const { channelStream } = await import('../transport/stream.js')
  const target = await targetServer(t, (s) => s.pipe(s))
  const [a, b] = framedPair()
  const clientMux = new Protomux(a)
  const serverStats = newPipeStats()
  serveMux(new Protomux(b), { connect: connectTo(target), stats: serverStats })
  t.after(() => a.destroy())
  const stats = newPipeStats()
  const stream = channelStream(clientMux, { id: crypto.randomBytes(4), stats })
  const data = crypto.randomBytes(4 * 1024 * 1024)
  const chunks = []
  let paused = false
  const done = new Promise((resolve, reject) => {
    stream.on('data', (c) => {
      chunks.push(c)
      if (!paused && chunks.length === 3) {
        // A consumer that stops reading for a while: the echo target must be held back.
        paused = true
        stream.pause()
        setTimeout(() => stream.resume(), 500)
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
  assert.ok(paused)
  assert.ok(serverStats.maxQueued <= WINDOW + SLACK, 'target socket queue bounded: ' + serverStats.maxQueued)
})

test('pipe: a head given by the caller goes first, counted by the window like socket data', async (t) => {
  const target = await targetServer(t, (s) => s.pipe(s))
  const [a, b] = framedPair()
  const clientMux = new Protomux(a)
  serveMux(new Protomux(b), { connect: connectTo(target) })
  const sockets = new Set()
  const proxy = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket)
    socket.pause()
    pipeSocket(clientMux, socket, { id: crypto.randomBytes(4), head: Buffer.concat([Buffer.from('H'), crypto.randomBytes(200 * 1024)]) })
  })
  const port = await listenServer(proxy)
  t.after(async () => {
    for (const s of sockets) s.destroy()
    a.destroy()
    await closeServer(proxy)
  })
  const sock = net.createConnection({ port, host: '127.0.0.1', allowHalfOpen: true })
  const got = readAll(sock)
  sock.end('coda')
  const back = await got
  assert.equal(back.length, 1 + 200 * 1024 + 4)
  assert.equal(back[0], 'H'.charCodeAt(0))
  assert.equal(back.subarray(back.length - 4).toString(), 'coda')
  sock.destroy()
})
