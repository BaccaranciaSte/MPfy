// The client link (MPfyLink): lazy dial, pending sockets, backoff, immediate redial
// for a local socket, status events with rttMs, forward() with a head, openStream()
// and request(), waitConnected(), the control-channel ping. Against a fake DHT:
// no network.

import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import net from 'node:net'
import Protomux from 'protomux'
import { MPfyLink, generateKeyPair, keyPairFromSeed, parseResponse } from '../transport/client.js'
import { serveMux } from '../transport/server.js'
import { serveControl } from '../transport/control.js'
import { framedPair, listenServer, closeServer } from './helpers.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// connect() hands out one end of an in-memory stream pair and serves the other
// end like the real server does (channels -> TCP to `target`, pings answered), or
// fails.
class FakeDht extends EventEmitter {
  constructor (target, { rtt = 7 } = {}) {
    super()
    this.target = target
    this.rtt = rtt
    this.fail = false
    this.dialTimes = []
    this.live = new Set()
  }

  connect () {
    this.dialTimes.push(Date.now())
    const [a, b] = framedPair()
    a.setTimeout = () => {}
    if (this.rtt !== null) a.rawStream = { rtt: this.rtt }
    this.live.add(a)
    a.on('close', () => this.live.delete(a))
    if (this.fail) {
      setTimeout(() => {
        a.emit('error', Object.assign(new Error('not found'), { code: 'PEER_NOT_FOUND' }))
        a.destroy()
      }, 20)
      return a
    }
    setTimeout(() => {
      const mux = new Protomux(b)
      serveControl(mux)
      serveMux(mux, {
        connect: () => net.createConnection({ port: this.target, host: '127.0.0.1', allowHalfOpen: true })
      })
      a.emit('open')
    }, 20)
    return a
  }

  async destroy () {}
}

async function setup (t, { target = null, rtt = 7 } = {}) {
  const sockets = new Set()
  const server = target || net.createServer({ allowHalfOpen: true }, (s) => s.pipe(s))
  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  const port = await listenServer(server)
  const dht = new FakeDht(port, { rtt })
  const kp = generateKeyPair()
  const link = new MPfyLink({ serverPublicKey: 'ab'.repeat(32), keyPair: kp, dht })
  const statuses = []
  link.on('status', (s) => statuses.push(s))
  await link.listen()
  t.after(async () => {
    await link.close()
    for (const s of sockets) s.destroy()
    for (const c of dht.live) c.destroy()
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
    await closeServer(server)
  })
  return { link, dht, statuses }
}

function echoOnce (port, text) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ port, host: '127.0.0.1', allowHalfOpen: true })
    const chunks = []
    s.on('data', (c) => chunks.push(c))
    s.on('end', () => {
      s.destroy()
      resolve(Buffer.concat(chunks).toString())
    })
    s.on('error', reject)
    s.end(text)
  })
}

test('keys: a seed always gives the same key pair; generateKeyPair returns its seed', () => {
  const kp = generateKeyPair()
  assert.match(kp.seed, /^[0-9a-f]{64}$/)
  assert.deepEqual(keyPairFromSeed(kp.seed), { publicKey: kp.publicKey, secretKey: kp.secretKey })
  assert.deepEqual(keyPairFromSeed(Buffer.from(kp.seed, 'hex')), keyPairFromSeed(kp.seed))
  assert.throws(() => keyPairFromSeed('zz'))
})

test('link: dials lazily, on the first local connection, and pipes it; status carries rttMs', async (t) => {
  const { link, dht, statuses } = await setup(t)
  await sleep(100)
  assert.equal(dht.dialTimes.length, 0, 'no dial before anyone needs the link')
  assert.deepEqual(link.status, { connected: false, rttMs: null, lastError: null })
  assert.equal(await echoOnce(link.port, 'prima'), 'prima')
  assert.equal(dht.dialTimes.length, 1)
  assert.equal(await echoOnce(link.port, 'seconda'), 'seconda')
  assert.equal(dht.dialTimes.length, 1, 'one connection for everything')
  assert.deepEqual(statuses[0], { connected: true, rttMs: 7, lastError: null })
})

test('link: a dropped link is redialled with backoff 1 s, 2 s, ... and at once for a local socket', async (t) => {
  const { link, dht, statuses } = await setup(t)
  assert.equal(await echoOnce(link.port, 'x'), 'x')
  dht.fail = true
  for (const c of dht.live) c.destroy()
  await sleep(3400)
  // Dial 0 was the first connection; after the drop: +1 s, then +2 s.
  assert.ok(dht.dialTimes.length >= 3, 'retried: ' + dht.dialTimes.length)
  const retryGap = dht.dialTimes[2] - dht.dialTimes[1]
  assert.ok(retryGap >= 1800 && retryGap < 2800, 'second retry about 2 s after the first: ' + retryGap)
  assert.ok(statuses.some((s) => !s.connected && s.lastError === 'PEER_NOT_FOUND' && s.rttMs === null), 'error reported in status')

  // The next retry would be 4 s away: a local connection must not wait for it.
  dht.fail = false
  const before = Date.now()
  assert.equal(await echoOnce(link.port, 'di nuovo'), 'di nuovo')
  assert.ok(Date.now() - before < 1500, 'redialled at once for the local socket')
  assert.equal(link.status.connected, true)
})

test('link: local sockets wait while the link comes up, and refresh() redials a down link', async (t) => {
  const { link, dht } = await setup(t)
  dht.fail = true
  const first = net.createConnection({ port: link.port, host: '127.0.0.1' })
  first.on('error', () => {})
  await sleep(300)
  assert.ok(dht.dialTimes.length >= 1)
  dht.fail = false
  const t0 = Date.now()
  link.refresh()
  // The waiting socket goes through once a dial succeeds.
  const echoed = await new Promise((resolve) => {
    first.on('data', (c) => resolve(c.toString()))
    first.write('in attesa')
  })
  assert.equal(echoed, 'in attesa')
  assert.ok(Date.now() - t0 < 2500)
  first.destroy()
})

test('link: start() dials at once; waitConnected() is true when up, false after its time when down', async (t) => {
  const { link, dht } = await setup(t)
  link.start()
  assert.equal(await link.waitConnected(3000), true)
  assert.equal(dht.dialTimes.length, 1)
  dht.fail = true
  for (const c of dht.live) c.destroy()
  await sleep(50)
  const t0 = Date.now()
  assert.equal(await link.waitConnected(400), false)
  assert.ok(Date.now() - t0 >= 380)
  await assert.rejects(link.openStream({ timeout: 300 }), (err) => err.code === 'UNREACHABLE' && err.message === 'Fonte non raggiungibile')
})

test('link: without an rtt from the raw stream, rttMs comes from a ping on the control channel', async (t) => {
  const { link } = await setup(t, { rtt: null })
  link.start()
  assert.equal(await link.waitConnected(3000), true)
  for (let i = 0; i < 100 && link.status.rttMs === null; i++) await sleep(10)
  const { rttMs } = link.status
  assert.ok(typeof rttMs === 'number' && rttMs >= 1 && rttMs < 1000, 'rttMs from the pong: ' + rttMs)
})

test('link: forward() sends the head first, then the socket data, and pipes the answer back', async (t) => {
  const { link } = await setup(t)
  const proxy = net.createServer({ allowHalfOpen: true }, (socket) => {
    // Like the client core: read what arrives first, then hand the socket over.
    socket.once('data', (first) => {
      socket.pause()
      const counted = []
      link.forward(socket, { head: Buffer.concat([Buffer.from('TESTA:'), first]), ondata: (n) => counted.push(n) })
      socket.on('close', () => { proxy.counted = counted.reduce((a, b) => a + b, 0) })
    })
  })
  const port = await listenServer(proxy)
  t.after(() => closeServer(proxy))
  const back = await new Promise((resolve, reject) => {
    const s = net.createConnection({ port, host: '127.0.0.1', allowHalfOpen: true })
    const chunks = []
    s.on('data', (c) => chunks.push(c))
    s.on('end', () => {
      s.destroy()
      resolve(Buffer.concat(chunks).toString())
    })
    s.on('error', reject)
    s.write('uno-')
    setTimeout(() => s.end('due'), 100)
  })
  assert.equal(back, 'TESTA:uno-due')
  for (let i = 0; i < 50 && proxy.counted === undefined; i++) await sleep(10)
  assert.equal(proxy.counted, Buffer.byteLength('TESTA:uno-due'), 'ondata saw every response byte')
})

test('link: request() speaks HTTP/1.1 over a channel: JSON, a body, a 3 MB answer', async (t) => {
  const big = crypto.randomBytes(3 * 1024 * 1024)
  const seen = []
  const httpServer = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, host: req.headers.host, connection: req.headers.connection, type: req.headers['content-type'], body: Buffer.concat(chunks).toString() })
      if (req.url === '/big') {
        res.setHeader('Content-Length', big.length)
        res.end(big)
        return
      }
      if (req.url === '/chunked') {
        res.write('a')
        res.end('bc')
        return
      }
      res.statusCode = req.method === 'DELETE' ? 404 : 200
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ ok: true, echo: Buffer.concat(chunks).toString() }))
    })
  })
  const { link } = await setup(t, { target: httpServer })

  const r1 = await link.request('POST', '/api/playlists', { body: { name: 'In auto' }, timeout: 5000 })
  assert.equal(r1.status, 200)
  assert.equal(r1.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(Buffer.from(r1.body).toString()), { ok: true, echo: '{"name":"In auto"}' })
  assert.deepEqual(seen[0], { method: 'POST', url: '/api/playlists', host: '127.0.0.1', connection: 'close', type: 'application/json', body: '{"name":"In auto"}' })

  const r2 = await link.request('DELETE', '/api/admin/clients/self', { timeout: 2000 })
  assert.equal(r2.status, 404)

  const r3 = await link.request('GET', '/big')
  assert.equal(r3.status, 200)
  assert.ok(Buffer.from(r3.body).equals(big), 'every byte of the 3 MB answer, in order')

  const r4 = await link.request('GET', '/chunked')
  assert.equal(Buffer.from(r4.body).toString(), 'abc', 'chunked answer decoded')

  await assert.rejects(link.request('GET', 'no-slash'), /percorso/)
  await assert.rejects(link.request('GET', '/x', { headers: { 'X-Bad': 'a\r\nb' } }), /intestazione/)

  // The head goes out one byte per character: a non-ASCII path would arrive as
  // other bytes (only the low byte of each character), so it is refused; encoded,
  // it arrives intact.
  const name = 'ブルーリグレット.m4a' // no space: refused for its characters alone
  const before = seen.length
  await assert.rejects(link.request('PUT', '/api/upload/' + name, { body: 'x' }), /percorso non valido.*encodeURIComponent/)
  await assert.rejects(link.request('GET', '/api/upload/caffè'), /percorso/, 'Latin-1 is not ASCII either')
  await assert.rejects(link.request('GET', '/a b'), /percorso/)
  await assert.rejects(link.request('GET', '/x', { headers: { 'X-Name': 'ブルー' } }), /intestazione non valida: X-Name/)
  await assert.rejects(link.request('GET', '/x', { headers: { 'X-Bad': 'a\u0007b' } }), /intestazione/)
  assert.equal(seen.length, before, 'nothing refused reached the source')
  const r5 = await link.request('PUT', '/api/upload/' + encodeURIComponent(name), { body: 'x', headers: { 'X-Note': 'caffè\tok' } })
  assert.equal(r5.status, 200)
  assert.equal(decodeURIComponent(seen[seen.length - 1].url.slice('/api/upload/'.length)), name)
})

test('parseResponse: status, lower-case headers, Content-Length', () => {
  const r = parseResponse(Buffer.from('HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}extra'))
  assert.equal(r.status, 503)
  assert.equal(r.headers['content-type'], 'application/json')
  assert.equal(Buffer.from(r.body).toString(), '{}')
  assert.throws(() => parseResponse(Buffer.from('nonsense')), /Risposta non valida/)
})
