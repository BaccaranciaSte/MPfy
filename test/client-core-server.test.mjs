// Client core over a local HyperDHT testnet: the local HTTP server and its
// guards, the static UI, /local/sources, the forwarding to a source, the throughput
// meter, the state file, and client-node's lock (one client per state file). The
// source here is an "echo" source: a real MPfyTransportServer (permanent pairing,
// firewall) in front of a small HTTP server that reports exactly what it received,
// so the forwarded heads and bodies can be checked byte for byte. It has no
// profiles (/api/profile answers 404, unless a test makes it answer otherwise):
// the core's own requests to it (its sync) are recorded apart from what the page
// sends. Its /api/profile/photo answers 404 unless a test says otherwise.

import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import b4a from 'b4a'
import createTestnet from 'hyperdht/testnet.js'
import { spawn, spawnSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { MPfyTransportServer } from '../transport/server.js'
import { generateSecret, formatCode } from '../transport/code.js'
import { parseResponse, keyPairFromSeed } from '../transport/client.js'
import { createClientCore, CSP } from '../client-core/index.js'
import { formatProfileCode, profileKeys, proofValue, parseIdentity } from '../client-core/identity.js'
import sodium from 'sodium-native'
import { runClient, addSource, profileCommand, lockPathOf, LOCK_STARTING_MS } from '../client-node/index.mjs'
import { tmpDir, rmDir, request, json, waitFor, listenServer, closeServer, noise } from './helpers.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const CLIENT_NODE = fileURLToPath(new URL('../client-node/index.mjs', import.meta.url))

let testnet = null
let echo = null
let BASE = null
let WEB = null
const nodes = []

before(async () => {
  testnet = await createTestnet(3)
  BASE = tmpDir('mpfy-cc-')
  WEB = path.join(BASE, 'web')
  fs.mkdirSync(path.join(WEB, 'icons'), { recursive: true })
  fs.mkdirSync(path.join(WEB, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(WEB, 'index.html'), '<!doctype html><title>MPfy</title><p>app</p>\n')
  fs.writeFileSync(path.join(WEB, 'app.js'), 'console.log("mpfy")\n')
  fs.writeFileSync(path.join(WEB, 'icons', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>\n')
  fs.writeFileSync(path.join(WEB, 'sub', 'index.html'), '<p>sub</p>\n')
  fs.writeFileSync(path.join(WEB, '.hidden'), 'hidden\n')
  fs.writeFileSync(path.join(BASE, 'secret.txt'), 'SEGRETO\n')
  echo = await startEcho()
})

after(async () => {
  if (echo) await echo.close()
  await Promise.all(nodes.map((n) => n.destroy()))
  if (testnet) await testnet.destroy()
  rmDir(BASE)
})

function node () {
  const n = testnet.createNode()
  nodes.push(n)
  return n
}

// ------------------------------------------------------------------ the echo source

async function startEcho () {
  const seen = []
  const own = []
  const revoked = []
  const allowed = new Map()
  const big = new Map()
  const pairWaiters = []
  let revokeHold = null
  let pairHold = null
  let profileAnswer = null
  let photoAnswer = null
  let transport = null
  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    const rec = { method: req.method, url: req.url, httpVersion: req.httpVersion, rawHeaders: req.rawHeaders.slice(), complete: false }
    if (url.pathname === '/api/profile/photo') {
      own.push(rec)
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        rec.body = Buffer.concat(chunks)
        const answer = photoAnswer !== null ? photoAnswer(rec) : [404, '{"error":"Risorsa non trovata"}']
        if (answer === 'cut') {
          req.socket.destroy()
          return
        }
        res.writeHead(answer[0], { 'Content-Type': answer[2] || 'application/json' })
        res.end(answer[1])
      })
      return
    }
    if (url.pathname === '/api/profile' || url.pathname === '/api/recovery') {
      own.push(rec)
      const answer = url.pathname === '/api/profile' && profileAnswer !== null ? profileAnswer() : [404, '{"error":"Risorsa non trovata"}']
      Promise.resolve(answer).then(([status, text]) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(text)
      })
      return
    }
    seen.push(rec)
    // n bytes of noise: /big, a stream, a cover, the library. With pace=<ms> the
    // source makes them slowly, one piece of `piece` bytes every pace ms.
    if (url.pathname === '/big' || url.pathname.startsWith('/api/stream/') || url.pathname.startsWith('/api/cover/') || url.pathname === '/api/library') {
      const n = Number(url.searchParams.get('n'))
      const pace = Number(url.searchParams.get('pace') || 0)
      const size = pace > 0 ? Number(url.searchParams.get('piece') || 12000) : 65536
      if (!big.has(n)) big.set(n, noise('big', n))
      const data = big.get(n)
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': n })
      if (req.method === 'HEAD') return res.end()
      let at = 0
      const write = () => {
        while (at < n) {
          const piece = data.subarray(at, at + size)
          at += piece.length
          if (pace > 0) {
            res.write(piece)
            if (at < n) {
              setTimeout(write, pace)
              return
            }
          } else if (!res.write(piece)) {
            res.once('drain', write)
            return
          }
        }
        res.end()
      }
      write()
      return
    }
    if (url.pathname === '/api/admin/clients/self' && req.method === 'DELETE') {
      revoked.push(rec)
      // Like the real source: the device asking is forgotten (no longer admitted)
      // and its connections closed. A test may hold this until the next pairing.
      const who = transport.clientForPort(req.socket.remotePort)
      const finish = () => {
        if (who !== null) allowed.delete(who)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{"ok":true}')
        if (who !== null) transport.dropClient(who, { graceMs: 1000 })
      }
      const hold = revokeHold !== null ? revokeHold() : null
      if (hold !== null) hold.then(finish)
      else finish()
      return
    }
    const hash = crypto.createHash('sha256')
    let size = 0
    const slow = Number(url.searchParams.get('slow') || 0)
    req.on('data', (c) => {
      hash.update(c)
      size += c.length
      if (slow) {
        req.pause()
        setTimeout(() => req.resume(), slow)
      }
    })
    const hold = Number(url.searchParams.get('hold') || 0)
    if (hold) {
      req.pause()
      setTimeout(() => req.resume(), hold)
    }
    req.on('end', () => {
      rec.complete = true
      rec.bodyLength = size
      rec.sha256 = hash.digest('hex')
      const body = JSON.stringify(rec)
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
      res.end(req.method === 'HEAD' ? undefined : body)
    })
  })
  const port = await listenServer(httpServer)
  const secret = generateSecret()
  transport = new MPfyTransportServer({
    seed: crypto.randomBytes(32),
    isAllowed: (key) => allowed.has(key),
    onPaired: (key, name) => {
      allowed.set(key, name)
      for (const fn of pairWaiters.splice(0)) fn(key)
      // The source answers the pairing once this settles.
      if (pairHold !== null) {
        const hold = pairHold
        pairHold = null
        hold.reached()
        return hold.released
      }
    },
    pairingSecret: secret,
    sourceName: 'Eco',
    targetPort: port,
    dht: node()
  })
  await transport.listen()
  return {
    code: formatCode(secret),
    publicKey: b4a.toString(transport.publicKey, 'hex'),
    transport,
    seen,
    own,
    revoked,
    allowed,
    /**
     * The next DELETE /api/admin/clients/self is answered (and the device
     * forgotten) only after the next pairing, or after maxMs. Resolves with what
     * released it: 'paired' or 'timeout'.
     */
    holdNextRevoke (maxMs) {
      return new Promise((resolveOutcome) => {
        revokeHold = () => {
          revokeHold = null
          return new Promise((resolve) => {
            const timer = setTimeout(() => {
              resolve()
              resolveOutcome('timeout')
            }, maxMs)
            pairWaiters.push(() => {
              clearTimeout(timer)
              resolve()
              resolveOutcome('paired')
            })
          })
        }
      })
    },
    /**
     * How GET /api/profile is answered from now on: fn() gives [status, text] or a
     * promise of it; null: 404, a source without profiles.
     */
    answerProfile (fn) {
      profileAnswer = fn
    },
    /**
     * How /api/profile/photo is answered from now on: fn(rec) (rec.body: what came)
     * gives [status, body, type] or 'cut' (the connection dropped); null: 404.
     */
    answerPhoto (fn) {
      photoAnswer = fn
    },
    /** The next pairing is answered only after release(); `reached` resolves when it arrives. */
    holdNextPairing () {
      let reached = null
      let release = null
      const reachedP = new Promise((resolve) => { reached = resolve })
      const released = new Promise((resolve) => { release = resolve })
      pairHold = { reached, released }
      return { reached: reachedP, release }
    },
    async close () {
      await transport.close()
      await closeServer(httpServer)
    }
  }
}

// ------------------------------------------------------------------ helpers

async function startCore (t, { state = null, offlineWaitMs, headTimeoutMs, revokeTimeoutMs, firstSyncWaitMs, token } = {}) {
  const dir = tmpDir('mpfy-cc-state-')
  const statePath = path.join(dir, 'state.json')
  if (state !== null) fs.writeFileSync(statePath, typeof state === 'string' ? state : JSON.stringify(state))
  const events = []
  const logs = []
  const opts = { statePath, webRoot: WEB, port: 0, deviceName: 'Banco di prova', onEvent: (e) => events.push(e), log: (l) => logs.push(l), dht: node() }
  if (offlineWaitMs !== undefined) opts.offlineWaitMs = offlineWaitMs
  if (headTimeoutMs !== undefined) opts.headTimeoutMs = headTimeoutMs
  if (revokeTimeoutMs !== undefined) opts.revokeTimeoutMs = revokeTimeoutMs
  if (firstSyncWaitMs !== undefined) opts.firstSyncWaitMs = firstSyncWaitMs
  if (token !== undefined) opts.token = token
  const core = createClientCore(opts)
  const { port } = await core.start()
  t.after(async () => {
    await core.stop()
    rmDir(dir)
  })
  return { core, port, dir, statePath, events, logs, origin: 'http://127.0.0.1:' + port, readState: () => JSON.parse(fs.readFileSync(statePath, 'utf8')) }
}

async function addEcho (c, name) {
  const res = await request(c.port, 'POST', '/local/sources', { body: name ? { code: echo.code, name } : { code: echo.code }, timeout: 30000 })
  assert.equal(res.status, 201, res.body.toString())
  const { source } = json(res)
  await waitFor(() => c.core.state().sources.find((s) => s.id === source.id)?.connected, { timeout: 15000, what: 'echo link up' })
  return source
}

/** One raw TCP exchange: write the pieces (with a delay between them), collect until close. */
function raw (port, pieces, { delay = 0, end = false, timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1')
    const chunks = []
    const timer = setTimeout(() => {
      sock.destroy()
      reject(new Error('raw exchange timed out'))
    }, timeout)
    sock.on('data', (c) => chunks.push(c))
    sock.on('error', () => {})
    sock.on('close', () => {
      clearTimeout(timer)
      resolve(Buffer.concat(chunks))
    })
    sock.on('connect', async () => {
      for (const p of [].concat(pieces)) {
        if (sock.destroyed) return
        sock.write(p)
        if (delay) await sleep(delay)
      }
      if (end) sock.end()
    })
  })
}

function parsed (buf) {
  const r = parseResponse(buf)
  return { status: r.status, headers: r.headers, body: Buffer.from(r.body) }
}

function rawHeaderMap (rawHeaders) {
  const out = []
  for (let i = 0; i < rawHeaders.length; i += 2) out.push([rawHeaders[i], rawHeaders[i + 1]])
  return out
}

function streamGet (port, urlPath, { onresponse } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, agent: false }, (res) => onresponse(res, resolve, reject, req))
    req.on('error', reject)
  })
}

async function noLeaks (c, sourceId) {
  await waitFor(() => {
    const st = c.core.state()
    const s = st.sources.find((x) => x.id === sourceId)
    const p = s.stats.pipes
    const sp = echo.transport.stats.pipes
    return st.connections === 0 && p.opened === p.closed && sp.opened === sp.closed
  }, { timeout: 10000, what: 'every socket and channel closed' })
}

// ------------------------------------------------------------------ tests

test('static UI: index, SPA fallback, 404 for a missing asset, ETag and 304, HEAD, CSP, nothing outside webRoot', async (t) => {
  const c = await startCore(t)
  const home = await request(c.port, 'GET', '/')
  assert.equal(home.status, 200)
  assert.equal(home.body.toString(), fs.readFileSync(path.join(WEB, 'index.html'), 'utf8'))
  assert.equal(home.headers['content-type'], 'text/html; charset=utf-8')
  assert.equal(home.headers['cache-control'], 'no-cache')
  assert.equal(home.headers['content-security-policy'], CSP)
  assert.equal(CSP, "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'")
  assert.equal(home.headers.connection, 'close')
  // No other site may show the UI inside a frame of its own (a click there would be
  // a click here): every answer of the core says so, its JSON and errors included.
  const answers = {
    home,
    sources: await request(c.port, 'GET', '/local/sources'),
    error: await request(c.port, 'GET', '/local/profile/code'),
    refused: await request(c.port, 'GET', '/', { headers: { host: 'example.com' } }),
    alias: await request(c.port, 'GET', '/impostazioni', { headers: { host: 'localhost:' + c.port } })
  }
  for (const [what, r] of Object.entries(answers)) {
    assert.equal(r.headers['x-frame-options'], 'DENY', what)
    assert.equal(r.headers['content-security-policy'], CSP, what)
  }
  assert.deepEqual(Object.values(answers).map((r) => r.status), [200, 200, 404, 403, 308])
  assert.match(home.headers.etag, /^W\/"[0-9a-f]+-[0-9a-f]+"$/)

  const again = await request(c.port, 'GET', '/', { headers: { 'if-none-match': home.headers.etag } })
  assert.equal(again.status, 304)
  assert.equal(again.body.length, 0)
  assert.equal(again.headers.etag, home.headers.etag)

  for (const route of ['/library', '/album/0a1b2c3d', '/impostazioni/fonte/abcd1234', '/search?q=x.y']) {
    const r = await request(c.port, 'GET', route)
    assert.equal(r.status, 200, route)
    assert.equal(r.body.toString(), home.body.toString(), route + ' falls back to index.html')
  }
  const js = await request(c.port, 'GET', '/app.js')
  assert.equal(js.headers['content-type'], 'text/javascript; charset=utf-8')
  assert.equal(js.body.toString(), 'console.log("mpfy")\n')
  assert.equal((await request(c.port, 'GET', '/icons/logo.svg')).headers['content-type'], 'image/svg+xml')
  assert.equal((await request(c.port, 'GET', '/sub/')).body.toString(), '<p>sub</p>\n', 'a directory serves its index.html')
  const missing = await request(c.port, 'GET', '/js/missing.js')
  assert.equal(missing.status, 404)
  assert.deepEqual(json(missing), { error: 'Risorsa non trovata' })

  const head = await request(c.port, 'HEAD', '/app.js')
  assert.equal(head.status, 200)
  assert.equal(head.headers['content-length'], String(fs.statSync(path.join(WEB, 'app.js')).size))
  assert.equal(head.body.length, 0)

  const post = await request(c.port, 'POST', '/', { body: 'x' })
  assert.equal(post.status, 405)
  assert.equal(post.headers.allow, 'GET, HEAD')

  for (const evil of ['/..%2fsecret.txt', '/%2e%2e/secret.txt', '/..%5csecret.txt', '/sub/..%2f..%2fsecret.txt', '/.hidden', '/C:%5cWindows%5cwin.ini', '/app.js%00.png']) {
    const buf = await raw(c.port, 'GET ' + evil + ' HTTP/1.1\r\nHost: 127.0.0.1:' + c.port + '\r\n\r\n')
    const r = parsed(buf)
    assert.equal(r.status, 404, evil)
    assert.ok(!r.body.toString().includes('SEGRETO') && !r.body.toString().includes('hidden'), evil)
  }
})

test('guards: Host, CSRF on non-GET requests and on /local GETs, foreign Origin allowed on /s GETs, localhost sent to the one origin', async (t) => {
  const c = await startCore(t)
  const evil = 'http://evil.example'
  const refused = (res) => {
    assert.equal(res.status, 403)
    assert.deepEqual(json(res), { error: 'Richiesta rifiutata' })
  }
  refused(await request(c.port, 'POST', '/local/sources', { body: { code: 'x' }, headers: { origin: evil } }))
  refused(await request(c.port, 'POST', '/local/sources', { body: { code: 'x' }, headers: { origin: 'null' } }))
  refused(await request(c.port, 'POST', '/local/sources', { body: { code: 'x' }, headers: { origin: 'http://localhost:' + c.port } }))
  refused(await request(c.port, 'GET', '/local/sources', { headers: { origin: evil } }))
  refused(await request(c.port, 'GET', '/', { headers: { host: 'evil.example:' + c.port } }))
  refused(await request(c.port, 'GET', '/local/sources', { headers: { host: '127.0.0.1:1' } }))
  // Our own origin, or none: the request reaches its handler.
  const own = await request(c.port, 'POST', '/local/sources', { body: { code: 'x' }, headers: { origin: c.origin } })
  assert.equal(own.status, 400)
  assert.deepEqual(json(own), { error: 'Codice non valido', code: 'bad_code' })
  assert.equal((await request(c.port, 'POST', '/local/sources', { body: { code: 'x' } })).status, 400)
  assert.equal((await request(c.port, 'GET', '/local/sources', { headers: { origin: c.origin } })).status, 200)
  assert.equal((await request(c.port, 'GET', '/', { headers: { origin: evil } })).status, 200, 'a static GET is not guarded by Origin')

  // localhost and [::1] name this core but are other origins for a browser, which
  // the CSRF guard refuses: a page opened there would load and then see every
  // change refused. Any request by those names goes to the same target on the one
  // origin (308: method and body kept).
  for (const alias of ['localhost:' + c.port, '[::1]:' + c.port, 'LocalHost:' + c.port]) {
    for (const [method, target] of [['GET', '/'], ['GET', '/album/0a1b2c3d?x=1'], ['GET', '/local/sources'], ['HEAD', '/app.js'], ['GET', '/s/abcd1234/api/library'], ['POST', '/local/sources']]) {
      const r = await request(c.port, method, target, { headers: { host: alias }, body: method === 'POST' ? { code: 'x' } : null })
      assert.equal(r.status, 308, method + ' ' + alias + target)
      assert.equal(r.headers.location, c.origin + target, method + ' ' + alias + target)
      assert.equal(r.body.length, 0)
    }
  }
  const location = (await request(c.port, 'GET', '/library', { headers: { host: 'localhost:' + c.port } })).headers.location
  const followed = await request(c.port, 'GET', new URL(location).pathname)
  assert.equal(followed.status, 200, 'the redirect leads to the UI')
  assert.equal(followed.body.toString(), fs.readFileSync(path.join(WEB, 'index.html'), 'utf8'))
  // A page on the alias origin itself still cannot change anything.
  refused(await request(c.port, 'POST', '/local/sources', { body: { code: 'x' }, headers: { host: 'localhost:' + c.port, origin: 'http://localhost:' + c.port } }))
  refused(await request(c.port, 'GET', '/local/sources', { headers: { host: 'localhost:' + c.port, origin: evil } }))
  refused(await request(c.port, 'GET', '/', { headers: { host: 'localhost:1' } }))

  const src = await addEcho(c)
  const get = await request(c.port, 'GET', '/s/' + src.id + '/echo', { headers: { origin: evil } })
  assert.equal(get.status, 200, 'GET /s/... with a foreign Origin is forwarded')
  assert.ok(!rawHeaderMap(json(get).rawHeaders).some(([n]) => n.toLowerCase() === 'origin'), 'and its Origin removed')
  refused(await request(c.port, 'PUT', '/s/' + src.id + '/echo', { body: 'x', headers: { origin: evil } }))
  refused(await request(c.port, 'DELETE', '/local/sources/' + src.id, { headers: { origin: evil } }))
  assert.equal(c.core.state().sources.length, 1, 'nothing removed by the refused DELETE')
})

test('token (the Android app): /local and /s need it as the cookie or the header, the UI files do not, and it never reaches the source', async (t) => {
  const token = crypto.randomBytes(32).toString('hex')
  const c = await startCore(t, { token })
  const refused = (res, what) => {
    assert.equal(res.status, 403, what)
    assert.deepEqual(json(res), { error: 'Richiesta rifiutata' }, what)
  }
  const cookie = { cookie: 'a=1; mpfy_token=' + token + '; b=2' }
  const header = { 'x-mpfy-token': token }
  refused(await request(c.port, 'GET', '/local/sources'), 'no token')
  refused(await request(c.port, 'GET', '/local/sources', { headers: { 'x-mpfy-token': token.slice(0, -1) + (token.endsWith('0') ? '1' : '0') } }), 'a wrong token')
  refused(await request(c.port, 'GET', '/local/sources', { headers: { 'x-mpfy-token': token + '00' } }), 'a longer token')
  refused(await request(c.port, 'GET', '/local/sources', { headers: { cookie: 'mpfy_token_x=' + token } }), 'another cookie name')
  refused(await request(c.port, 'POST', '/local/sources', { body: { code: echo.code } }), 'pairing without the token')
  refused(await request(c.port, 'GET', '/s/abcd1234/api/library'), '/s without the token')
  assert.equal(c.core.state().sources.length, 0)
  assert.equal((await request(c.port, 'GET', '/local/sources', { headers: cookie })).status, 200)
  assert.equal((await request(c.port, 'GET', '/local/sources', { headers: header })).status, 200)
  assert.equal((await request(c.port, 'GET', '/')).status, 200, 'the UI files are open')
  assert.equal((await request(c.port, 'GET', '/app.js')).status, 200)

  const added = await request(c.port, 'POST', '/local/sources', { body: { code: echo.code }, headers: header, timeout: 30000 })
  assert.equal(added.status, 201, added.body.toString())
  const src = json(added).source
  await waitFor(() => c.core.state().sources.find((s) => s.id === src.id)?.connected, { timeout: 15000, what: 'echo link up' })
  refused(await request(c.port, 'GET', '/s/' + src.id + '/echo'), 'a source without the token')
  for (const h of [cookie, header]) {
    const res = await request(c.port, 'GET', '/s/' + src.id + '/echo', { headers: h })
    assert.equal(res.status, 200)
    const names = rawHeaderMap(json(res).rawHeaders).map(([n]) => n.toLowerCase())
    assert.ok(!names.includes('cookie') && !names.includes('x-mpfy-token'), 'the token stays on the phone: ' + names.join(','))
  }
})

test('/local/sources: add with a chunked body, add again, principal, no local names, errors with codes; the state file follows', async (t) => {
  const ownBefore = echo.own.length
  const c = await startCore(t)
  assert.deepEqual(json(await request(c.port, 'GET', '/local/sources')), { sources: [] })
  const st0 = c.readState()
  assert.match(st0.clientSeed, /^[0-9a-f]{64}$/)
  assert.deepEqual(st0.sources, [])

  // Errors first.
  const bad = async (method, p, body, status, error, code, headers = {}) => {
    const res = await request(c.port, method, p, { body, headers })
    assert.equal(res.status, status, method + ' ' + p + ' ' + res.body)
    assert.deepEqual(json(res), { error, code })
    return res
  }
  await bad('POST', '/local/sources', '{not json', 400, 'Richiesta non valida', 'bad_request', { 'content-type': 'application/json' })
  await bad('POST', '/local/sources', '[1]', 400, 'Richiesta non valida', 'bad_request')
  await bad('POST', '/local/sources', { code: 'MPFY-1234' }, 400, 'Codice non valido', 'bad_code')
  await bad('POST', '/local/sources', { code: formatProfileCode(crypto.randomBytes(32)) }, 400, 'Questo \u00e8 il codice del profilo', 'profile_code')
  await bad('POST', '/local/sources', 'x'.repeat(70000), 413, 'Richiesta troppo grande', 'too_large')
  await bad('PUT', '/local/sources', { code: echo.code }, 405, 'Metodo non consentito', 'method_not_allowed')
  await bad('GET', '/local/other', undefined, 404, 'Risorsa non trovata', 'not_found')
  await bad('PATCH', '/local/sources/abcdef12', { principal: true }, 404, 'Fonte sconosciuta', 'not_found')

  // Add, with the JSON body sent chunked and a 100-continue expectation. A name
  // sent along is ignored: the source's own name is the name.
  const body = JSON.stringify({ code: echo.code.toLowerCase().replace(/-/g, ' '), name: '  Casa  ' })
  const pieces = ['POST /local/sources HTTP/1.1\r\nHost: 127.0.0.1:' + c.port + '\r\nTransfer-Encoding: chunked\r\nExpect: 100-continue\r\nContent-Type: application/json\r\n\r\n']
  for (let i = 0; i < body.length; i += 7) {
    const part = body.slice(i, i + 7)
    pieces.push(Buffer.byteLength(part).toString(16) + '\r\n' + part + '\r\n')
  }
  pieces.push('0\r\n\r\n')
  const addedBuf = await raw(c.port, pieces, { delay: 2, timeout: 40000 })
  assert.ok(addedBuf.toString('latin1').startsWith('HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 201 Created\r\n'), addedBuf.toString('latin1').slice(0, 80))
  const added = JSON.parse(parsed(addedBuf.subarray(25)).body.toString())
  const id = echo.publicKey.slice(0, 8)
  assert.equal(added.source.id, id)
  assert.equal(added.source.name, 'Eco')
  assert.equal(added.source.principal, true)
  assert.ok(added.source.addedAt > 0)
  assert.equal(added.source.role, null, 'a source without profiles')
  assert.equal(added.source.named, null)
  assert.equal(added.source.profiles, false, 'it said so within the first sync wait')
  assert.equal(echo.allowed.get(c.core.state().publicKey), 'Banco di prova', 'the source admitted this device under its name')
  await waitFor(() => c.core.state().sources[0].connected, { timeout: 15000, what: 'link up' })
  assert.deepEqual(c.readState().sources, [{ id, name: 'Eco', serverPublicKey: echo.publicKey, principal: true, addedAt: added.source.addedAt, role: null, named: null, profiles: false, social: 0, card: null }])

  const list = json(await request(c.port, 'GET', '/local/sources')).sources
  assert.equal(list.length, 1)
  assert.deepEqual(Object.keys(list[0]).sort(), ['addedAt', 'connected', 'id', 'lastError', 'name', 'named', 'principal', 'profiles', 'role', 'rttMs', 'social', 'throughputKbps'])
  assert.equal(list[0].connected, true)
  assert.equal(list[0].lastError, null)
  assert.ok(list[0].rttMs === null || list[0].rttMs >= 0)
  assert.ok(c.events.some((e) => e.type === 'sources' && e.sources.length === 1 && e.sources[0].connected), 'an event says the link is up')

  // The same code again: nothing new, 200, the source kept as it is.
  const again = await request(c.port, 'POST', '/local/sources', { body: { code: echo.code, name: 'Altro' }, timeout: 30000 })
  assert.equal(again.status, 200)
  assert.equal(json(again).source.name, 'Eco')
  assert.equal(c.readState().sources.length, 1)

  // No local names (the name is the source's own); principal as before.
  await bad('PATCH', '/local/sources/' + id.toUpperCase(), { name: ' Mi A2 ' }, 400, 'Richiesta non valida', 'bad_request')
  await bad('PATCH', '/local/sources/' + id, { name: 'Mi A2', principal: true }, 400, 'Richiesta non valida', 'bad_request')
  await bad('PATCH', '/local/sources/' + id, { principal: false }, 400, 'Richiesta non valida', 'bad_request')
  await bad('PATCH', '/local/sources/' + id, {}, 400, 'Richiesta non valida', 'bad_request')
  assert.equal(c.readState().sources[0].name, 'Eco')
  assert.equal(json(await request(c.port, 'PATCH', '/local/sources/' + id, { body: { principal: true } })).source.principal, true)
  const one = await request(c.port, 'GET', '/local/sources/' + id)
  assert.equal(json(one).source.name, 'Eco')
  // Its sync asked who this device is there and found no profiles, without headers.
  await waitFor(() => echo.own.length > ownBefore, { what: 'the sync' })
  assert.ok(echo.own.slice(ownBefore).every((r) => r.method === 'GET' && r.url === '/api/profile' && !rawHeaderMap(r.rawHeaders).some(([n]) => /^x-mpfy-profile/i.test(n))))
})

test('profiles: a source without profiles says false already in the answer that adds it; unknown until a sync tells, and the change is announced; a 200 that is not a profile answer tells nothing; the state file keeps it across a restart', async (t) => {
  t.after(() => echo.answerProfile(null))
  const id = echo.publicKey.slice(0, 8)
  const lastSources = (c) => c.events.filter((e) => e.type === 'sources').pop().sources
  const fields = (s) => [s.profiles, s.role, s.named]
  const notFound = [404, '{"error":"Risorsa non trovata"}']
  // GET /api/profile answered only once the test says so.
  const held = () => {
    const h = { asked: false, release: null }
    echo.answerProfile(() => new Promise((resolve) => {
      h.asked = true
      h.release = (answer = notFound) => resolve(answer)
    }))
    return h
  }

  // A source without profiles answers 404 well within the first sync wait.
  const c = await startCore(t)
  const added = await addEcho(c)
  assert.deepEqual(fields(added), [false, null, null])
  assert.deepEqual(fields(json(await request(c.port, 'GET', '/local/sources')).sources[0]), [false, null, null])
  assert.equal(c.core.state().sources[0].profiles, false)
  assert.equal(c.readState().sources[0].profiles, false)
  assert.equal(lastSources(c)[0].profiles, false)
  const text = fs.readFileSync(c.statePath, 'utf8')
  await c.core.stop()

  // Before its first sync: unknown. When the answer comes, null -> false is announced.
  const h1 = held()
  const c1 = await startCore(t, { firstSyncWaitMs: 300 })
  const early = await request(c1.port, 'POST', '/local/sources', { body: { code: echo.code }, timeout: 30000 })
  assert.equal(early.status, 201, early.body.toString())
  assert.deepEqual(fields(json(early).source), [null, null, null], 'the first sync is not over')
  assert.equal(c1.readState().sources[0].profiles, null)
  await waitFor(() => h1.asked, { timeout: 15000, what: 'the sync asking' })
  assert.equal(lastSources(c1)[0].profiles, null)
  const seen = c1.events.length
  h1.release()
  await waitFor(() => c1.events.slice(seen).some((e) => e.type === 'sources' && e.sources[0].profiles === false), { what: 'null -> false announced' })
  assert.equal(c1.readState().sources[0].profiles, false)
  await c1.core.stop()

  // A 200 that is not a profile answer: still unknown, role too; then a 404 tells.
  echo.answerProfile(() => [200, '{"role":"owner","profileId":null}'])
  const c2 = await startCore(t)
  const odd = await addEcho(c2)
  assert.deepEqual(fields(odd), [null, null, null])
  assert.deepEqual(json(await request(c2.port, 'POST', '/local/sync', { timeout: 30000 })), { ok: true })
  assert.deepEqual(fields(json(await request(c2.port, 'GET', '/local/sources/' + id)).source), [null, null, null])
  echo.answerProfile(null)
  await request(c2.port, 'POST', '/local/sync', { timeout: 30000 })
  assert.deepEqual(fields(json(await request(c2.port, 'GET', '/local/sources/' + id)).source), [false, null, null])
  await c2.core.stop()

  // Across a restart, before any sync can answer: what the file says.
  const h3 = held()
  const c3 = await startCore(t, { state: text })
  await waitFor(() => h3.asked, { timeout: 15000, what: 'the sync asking' })
  assert.deepEqual(fields(json(await request(c3.port, 'GET', '/local/sources')).sources[0]), [false, null, null])
  assert.equal(c3.core.state().sources[0].profiles, false)
  h3.release()
  await c3.core.stop()

  // A source that had profiles and has none now: it says so, and it is announced.
  const st = JSON.parse(text)
  Object.assign(st.sources[0], { profiles: true, role: 'member', named: true })
  const h4 = held()
  const c4 = await startCore(t, { state: st })
  await waitFor(() => h4.asked, { timeout: 15000, what: 'the sync asking' })
  assert.deepEqual(fields(json(await request(c4.port, 'GET', '/local/sources')).sources[0]), [true, 'member', true], 'as the file says')
  const before = c4.events.length
  h4.release()
  await waitFor(() => c4.events.slice(before).some((e) => e.type === 'sources' && e.sources[0].profiles === false), { what: 'true -> false announced' })
  assert.deepEqual(fields(lastSources(c4)[0]), [false, null, null])
  assert.deepEqual(fields(c4.readState().sources[0]), [false, null, null])
})

test('profile headers: on every forwarded request and on the core\'s own (sync, removal), the page\'s never; the same value each time; none without a profile', async (t) => {
  // The profile of the published vector: its id and signing key are known.
  const keys = profileKeys(Buffer.from(Array.from({ length: 32 }, (_, i) => i)))
  const profile = { id: keys.id, secret: keys.secret, name: 'Bacca', nameUpdatedAt: 5, createdAt: 5 }
  const c = await startCore(t, { state: { clientSeed: crypto.randomBytes(32).toString('hex'), profile, sources: [] } })
  const src = await addEcho(c)
  const me = c.core.state().publicKey
  const expected = proofValue(keys, me, echo.publicKey)
  assert.equal(expected.slice(0, 64), 'e4abea2357415e195ded1df44e7a5cb392eb9322970e2598bee865e921ca877e')
  const message = Buffer.concat([Buffer.from('mpfy/profile/1'), Buffer.from(me, 'hex'), Buffer.from(echo.publicKey, 'hex')])
  assert.ok(sodium.crypto_sign_verify_detached(Buffer.from(expected.slice(64), 'hex'), message, Buffer.from(expected.slice(0, 64), 'hex')), 'signed for this device on this source')
  const profileFields = (rec) => rawHeaderMap(rec.rawHeaders).filter(([n]) => /^x-mpfy-profile/i.test(n))
  const ours = [['X-MPfy-Profile', '22de25661c578b57b919dfcada067bd4'], ['X-MPfy-Profile-Proof', expected]]

  // Forwarded: the page's own profile headers (any case) never pass, the core's go.
  const pageHeaders = { 'x-mpfy-profile': 'f'.repeat(32), 'X-MPFY-PROFILE-PROOF': 'e'.repeat(192), connection: 'x-mpfy-profile' }
  for (let i = 0; i < 2; i++) {
    const r = await request(c.port, 'GET', '/s/' + src.id + '/echo/p' + i, { headers: pageHeaders })
    assert.equal(r.status, 200)
    assert.deepEqual(profileFields(json(r)), ours, 'request ' + i)
  }
  const up = await request(c.port, 'PUT', '/s/' + src.id + '/echo/up', { body: Buffer.alloc(5000, 1), headers: pageHeaders })
  assert.deepEqual(profileFields(json(up)), ours, 'an upload too')

  // Its own requests: the sync asked who this device is with them.
  const mine = () => echo.own.filter((r) => profileFields(r).length > 0 && profileFields(r)[0][1] === keys.id)
  await waitFor(() => mine().length > 0, { what: 'the sync with the headers' })
  for (const rec of mine()) assert.deepEqual(profileFields(rec), ours)

  // ... and so does the removal.
  const revokedBefore = echo.revoked.length
  assert.deepEqual(json(await request(c.port, 'DELETE', '/local/sources/' + src.id)), { ok: true, revoked: true })
  assert.deepEqual(profileFields(echo.revoked[revokedBefore]), ours)

  // A core without a profile sends none, and drops the page's all the same.
  const plain = await startCore(t)
  const other = await addEcho(plain)
  const r = await request(plain.port, 'GET', '/s/' + other.id + '/echo/none', { headers: pageHeaders })
  assert.deepEqual(profileFields(json(r)), [])
})

test('photo and a source from before photos: nothing asked, sent or logged; a photo that cannot be sent or read never holds back the rest of the sync', async (t) => {
  t.after(() => {
    echo.answerProfile(null)
    echo.answerPhoto(null)
  })
  const keys = profileKeys(crypto.randomBytes(32))
  const c = await startCore(t, { state: { clientSeed: crypto.randomBytes(32).toString('hex'), profile: { id: keys.id, secret: keys.secret, name: 'Bacca', nameUpdatedAt: 5, createdAt: 5 }, sources: [] } })
  const mine = (from) => echo.own.slice(from).filter((r) => rawHeaderMap(r.rawHeaders).some(([n, v]) => n.toLowerCase() === 'x-mpfy-profile' && v === keys.id))
  const photoAsks = (ownFrom, seenFrom) => echo.own.slice(ownFrom).concat(echo.seen.slice(seenFrom)).filter((r) => r.url.startsWith('/api/profile/photo'))
  const profileAsks = (from) => mine(from).filter((r) => r.method === 'GET' && r.url === '/api/profile').length
  const answer = (more = {}) => [200, JSON.stringify({ role: 'member', profileId: keys.id, name: 'Bacca', nameUpdatedAt: 5, recovery: null, source: { name: 'Eco', named: false }, ...more })]

  // A source from before photos: no photo fields in its profile answer.
  echo.answerProfile(() => answer())
  const ownAt = echo.own.length
  const seenAt = echo.seen.length
  await addEcho(c)
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), noise('echo-photo', 3000), Buffer.from([0xff, 0xd9])])
  const put = await request(c.port, 'PUT', '/local/profile/photo', { body: jpeg, headers: { 'content-type': 'image/jpeg' } })
  assert.equal(put.status, 200, put.body.toString())
  const local = c.readState().profile.photoUpdatedAt
  assert.ok(local > 0)
  for (let i = 0; i < 2; i++) assert.deepEqual(json(await request(c.port, 'POST', '/local/sync', { timeout: 30000 })), { ok: true })
  assert.ok(profileAsks(ownAt) >= 3, 'the syncs ran: ' + profileAsks(ownAt))
  assert.deepEqual(photoAsks(ownAt, seenAt), [], 'never asked about the photo')
  assert.deepEqual(c.logs.filter((l) => /photo/.test(l)), [], 'and nothing logged for it')

  // A source with photos that keeps an older one: the photo goes there, as base64
  // with this device's time. Refused there: logged, and the recovery blob that
  // source still holds is deleted all the same.
  let at = echo.own.length
  echo.answerProfile(() => answer({ photo: null, photoUpdatedAt: 1, recovery: { updatedAt: 7 } }))
  echo.answerPhoto(() => [500, '{"error":"no"}'])
  assert.deepEqual(json(await request(c.port, 'POST', '/local/sync', { timeout: 30000 })), { ok: true })
  const sent = mine(at).filter((r) => r.url === '/api/profile/photo')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].method, 'PUT')
  assert.deepEqual(JSON.parse(sent[0].body.toString()), { photo: jpeg.toString('base64'), photoUpdatedAt: local })
  assert.ok(c.logs.some((l) => /photo not sent \(500\)/.test(l)), c.logs.join(' | '))
  assert.ok(mine(at).some((r) => r.method === 'DELETE' && r.url === '/api/recovery'), 'the recovery step still ran')

  // A newer photo there whose bytes never come (the connection drops): logged,
  // nothing taken, the recovery step still runs.
  at = echo.own.length
  echo.answerProfile(() => answer({ photo: 'c'.repeat(64), photoUpdatedAt: Date.now() + 60000, recovery: { updatedAt: 7 } }))
  echo.answerPhoto(() => 'cut')
  assert.deepEqual(json(await request(c.port, 'POST', '/local/sync', { timeout: 30000 })), { ok: true })
  assert.deepEqual(mine(at).filter((r) => r.url === '/api/profile/photo').map((r) => r.method), ['GET'])
  assert.ok(c.logs.some((l) => /photo not synced/.test(l)), c.logs.join(' | '))
  assert.ok(mine(at).some((r) => r.method === 'DELETE' && r.url === '/api/recovery'), 'the recovery step still ran')
  assert.deepEqual([c.readState().profile.photo, c.readState().profile.photoUpdatedAt], [crypto.createHash('sha256').update(jpeg).digest('hex'), local], 'the photo here unchanged')
})

test('forwarding: rewritten head, query kept, unknown source 404, chunked and Content-Length uploads with backpressure, HEAD, one request per connection', async (t) => {
  const c = await startCore(t)
  const src = await addEcho(c)
  const base = '/s/' + src.id

  const r = await request(c.port, 'GET', base + '/echo/a%20b?x=1&y=%2F', { headers: { origin: c.origin, referer: c.origin + '/library', 'x-keep': 'si', cookie: 'a=b' } })
  assert.equal(r.status, 200)
  const rec = json(r)
  assert.equal(rec.url, '/echo/a%20b?x=1&y=%2F')
  assert.equal(rec.httpVersion, '1.1')
  const fields = rawHeaderMap(rec.rawHeaders)
  const names = fields.map(([n]) => n.toLowerCase())
  assert.equal(fields[0][0], 'Host')
  assert.equal(fields[0][1], '127.0.0.1:8091')
  assert.deepEqual(fields[fields.length - 1], ['Connection', 'close'])
  assert.ok(!names.includes('origin') && !names.includes('referer'), 'Origin and Referer removed: ' + names)
  assert.equal(names.filter((n) => n === 'host').length, 1)
  assert.ok(fields.some(([n, v]) => n.toLowerCase() === 'x-keep' && v === 'si'), 'other fields kept')

  // Ids are lower-case hex: an upper-case one is another (unknown) id, when the
  // random key gave it any letter at all.
  const upper = src.id.toUpperCase() !== src.id ? ['/s/' + src.id.toUpperCase() + '/echo'] : []
  for (const p of ['/s/deadbeef/api/health', '/s//x', ...upper]) {
    const res = await request(c.port, 'GET', p)
    assert.equal(res.status, 404, p)
    assert.deepEqual(json(res), { error: 'Fonte sconosciuta' })
  }
  assert.equal((await request(c.port, 'GET', base)).status, 200, '/s/<id> alone is forwarded as /')
  assert.equal(echo.seen[echo.seen.length - 1].url, '/')

  // Content-Length upload of 4 MB to a source that reads slowly: the channel's
  // credit runs out and the local socket waits (backpressure), bytes intact.
  const payload = noise('upload', 4 * 1024 * 1024 + 123)
  const stalls = c.core.state().sources[0].stats.pipes.creditStalls
  const up = await request(c.port, 'PUT', base + '/echo?slow=20', { body: payload, timeout: 60000 })
  assert.equal(up.status, 200)
  const upRec = json(up)
  assert.equal(upRec.bodyLength, payload.length)
  assert.equal(upRec.sha256, crypto.createHash('sha256').update(payload).digest('hex'))
  assert.ok(c.core.state().sources[0].stats.pipes.creditStalls > stalls, 'the sender waited for credit')

  // Chunked upload in uneven pieces: passed through as chunked.
  const chunkedRes = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: c.port, method: 'POST', path: base + '/echo', agent: false }, (res) => {
      const chunks = []
      res.on('data', (d) => chunks.push(d))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    const data = noise('chunked', 300000)
    let at = 0
    const step = () => {
      if (at >= data.length) return req.end()
      const n = 1 + ((at * 7919) % 50000)
      req.write(data.subarray(at, at + n))
      at += n
      setImmediate(step)
    }
    step()
  })
  assert.equal(chunkedRes.status, 200)
  const chRec = JSON.parse(chunkedRes.body)
  assert.equal(chRec.bodyLength, 300000)
  assert.equal(chRec.sha256, crypto.createHash('sha256').update(noise('chunked', 300000)).digest('hex'))
  assert.ok(rawHeaderMap(chRec.rawHeaders).some(([n, v]) => n === 'Transfer-Encoding' && v === 'chunked'))

  // HEAD: headers only.
  const headBuf = await raw(c.port, 'HEAD ' + base + '/big?n=1000000 HTTP/1.1\r\nHost: 127.0.0.1:' + c.port + '\r\n\r\n')
  const headText = headBuf.toString('latin1')
  assert.match(headText, /^HTTP\/1\.1 200 OK\r\n/)
  assert.match(headText, /\r\nContent-Length: 1000000\r\n/i)
  assert.ok(headText.endsWith('\r\n\r\n'), 'no body after a HEAD answer')

  // One request per local connection: a pipelined second request never reaches
  // the source, and bytes past a Content-Length body are dropped, whether they
  // come in the same packet or later (the source holds its answer meanwhile). The
  // source's side counts exactly the rewritten head plus the body.
  const host = 'Host: 127.0.0.1:' + c.port + '\r\n'
  const seenBefore = echo.seen.length
  const sentHead = (line, extra = '') => Buffer.byteLength(line + '\r\nHost: 127.0.0.1:8091\r\n' + extra + 'Connection: close\r\n\r\n')
  let inBefore = echo.transport.stats.pipes.bytesIn
  const twoBuf = await raw(c.port, ['GET ' + base + '/echo/one?hold=300 HTTP/1.1\r\n' + host + '\r\nGET ' + base + '/echo/two HTTP/1.1\r\n' + host + '\r\n', 'GET ' + base + '/echo/four HTTP/1.1\r\n' + host + '\r\n'], { delay: 40 })
  assert.equal(parsed(twoBuf).status, 200)
  assert.equal(twoBuf.toString('latin1').split('HTTP/1.1 ').length - 1, 1, 'exactly one response')
  assert.equal(echo.transport.stats.pipes.bytesIn - inBefore, sentHead('GET /echo/one?hold=300 HTTP/1.1'), 'only the first request went out')
  inBefore = echo.transport.stats.pipes.bytesIn
  const extraBuf = await raw(c.port, ['POST ' + base + '/echo/three?hold=300 HTTP/1.1\r\n' + host + 'Content-Length: 5\r\n\r\nhel', 'loPOST /s/x HTTP/1.1\r\n\r\n', 'more bytes'], { delay: 40 })
  assert.equal(JSON.parse(parsed(extraBuf).body).sha256, crypto.createHash('sha256').update('hello').digest('hex'))
  assert.equal(echo.transport.stats.pipes.bytesIn - inBefore, sentHead('POST /echo/three?hold=300 HTTP/1.1', 'Content-Length: 5\r\n') + 5, 'the body and nothing after it')
  assert.deepEqual(echo.seen.slice(seenBefore).map((x) => x.url), ['/echo/one?hold=300', '/echo/three?hold=300'])

  // A chunked body with bad framing never reaches a reader: the connection is reset.
  const badChunked = await raw(c.port, 'POST ' + base + '/echo HTTP/1.1\r\nHost: 127.0.0.1:' + c.port + '\r\nTransfer-Encoding: chunked\r\n\r\nZZ\r\nhello\r\n')
  assert.equal(badChunked.length, 0)
  await noLeaks(c, src.id)
})

test('slow reader, aborted upload and aborted download: backpressure to the source, nothing left open', async (t) => {
  const c = await startCore(t)
  const src = await addEcho(c)
  const base = '/s/' + src.id
  const size = 8 * 1024 * 1024
  const expected = crypto.createHash('sha256').update(noise('big', size)).digest('hex')

  // A slow reader: the source's side of the channel has to wait for credit.
  const serverStalls = echo.transport.stats.pipes.creditStalls
  const got = await streamGet(c.port, base + '/big?n=' + size, {
    onresponse: (res, resolve) => {
      const hash = crypto.createHash('sha256')
      let n = 0
      res.on('data', (d) => {
        hash.update(d)
        n += d.length
        res.pause()
        setTimeout(() => res.resume(), 8)
      })
      res.on('end', () => resolve({ status: res.statusCode, n, sha: hash.digest('hex') }))
    }
  })
  assert.deepEqual(got, { status: 200, n: size, sha: expected })
  assert.ok(echo.transport.stats.pipes.creditStalls > serverStalls, 'the source waited for credit while the reader was slow')
  await noLeaks(c, src.id)

  // Aborted upload: 2 MB of a declared 20 MB, then the client vanishes.
  await new Promise((resolve) => {
    const sock = net.connect(c.port, '127.0.0.1', () => {
      sock.write('PUT ' + base + '/echo HTTP/1.1\r\nHost: 127.0.0.1:' + c.port + '\r\nContent-Length: ' + 20 * 1024 * 1024 + '\r\n\r\n')
      sock.write(noise('abort', 2 * 1024 * 1024), () => setTimeout(() => {
        sock.destroy()
        resolve()
      }, 200))
    })
    sock.on('error', () => {})
  })
  await noLeaks(c, src.id)

  // Aborted download: 1 MB read of 16 MB, then gone. The source stops sending
  // (mobile data is not spent on a song nobody listens to).
  const outBefore = echo.transport.stats.pipes.bytesOut
  const bigSize = 16 * 1024 * 1024
  await streamGet(c.port, base + '/big?n=' + bigSize, {
    onresponse: (res, resolve, reject, req) => {
      let n = 0
      res.on('data', (d) => {
        n += d.length
        if (n >= 1024 * 1024) {
          req.destroy()
          resolve()
        }
      })
      res.on('error', () => {})
    }
  })
  await noLeaks(c, src.id)
  const sent = echo.transport.stats.pipes.bytesOut - outBefore
  t.diagnostic('the source sent ' + (sent / 1048576).toFixed(1) + ' MB of 16 MB before it was stopped')
  assert.ok(sent < bigSize / 2, 'the source stopped: ' + sent + ' bytes sent')
  // The link is still fine after all that.
  assert.equal((await request(c.port, 'GET', base + '/echo')).status, 200)
})

test('upload backpressure: while the source reads nothing, the uploader is held back', async (t) => {
  const c = await startCore(t)
  const src = await addEcho(c)
  const total = 32 * 1024 * 1024
  const piece = Buffer.alloc(64 * 1024, 7)
  let written = 0
  let held = -1
  const res = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: c.port, method: 'PUT', path: '/s/' + src.id + '/echo?hold=2500', headers: { 'content-length': total }, agent: false }, (r) => {
      const chunks = []
      r.on('data', (d) => chunks.push(d))
      r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    const pump = () => {
      while (written < total) {
        const ok = req.write(piece)
        written += piece.length
        if (!ok) {
          req.once('drain', pump)
          return
        }
      }
      req.end()
    }
    pump()
    setTimeout(() => { held = written }, 2000)
  })
  t.diagnostic('accepted from the uploader while the source held: ' + (held / 1048576).toFixed(1) + ' MB')
  assert.equal(res.status, 200)
  assert.equal(JSON.parse(res.body).bodyLength, total)
  assert.ok(held > 0 && held < 12 * 1024 * 1024, 'held back at ' + held + ' bytes')
  await noLeaks(c, src.id)
})

test('throughput: measured on streams only, never on covers, the library or other answers', async (t) => {
  const c = await startCore(t)
  const src = await addEcho(c)
  const base = '/s/' + src.id
  const kbps = async () => json(await request(c.port, 'GET', '/local/sources')).sources[0].throughputKbps
  // A grid of covers being browsed: 12 KB every 200 ms. Their round trips say
  // nothing about the link: nothing is measured (before a song plays, "unknown"
  // means Max on Wi-Fi).
  for (let i = 0; i < 15; i++) {
    const r = await request(c.port, 'GET', base + '/api/cover/c' + i + '?n=12000')
    assert.equal(r.status, 200)
    assert.equal(r.body.length, 12000)
    await sleep(200)
  }
  // The library, which the source makes slowly (12 KB every 100 ms for 2 s): its
  // pace is the source's, not the link's.
  const lib = await request(c.port, 'GET', base + '/api/library?n=240000&pace=100&piece=12000', { timeout: 20000 })
  assert.equal(lib.body.length, 240000)
  assert.equal((await request(c.port, 'HEAD', base + '/api/stream/t0?n=5000000')).status, 200)
  assert.equal(await kbps(), null, 'no throughput from answers that are not streams')
  // A stream read as fast as it comes: the link's speed (a few, if the local link
  // is so fast that one stream is over before there is enough to say).
  let value = null
  for (let i = 1; i <= 6 && value === null; i++) {
    const r = await request(c.port, 'GET', base + '/api/stream/t' + i + '?n=' + 4 * 1024 * 1024, { timeout: 60000 })
    assert.equal(r.status, 200)
    assert.equal(r.body.length, 4 * 1024 * 1024)
    value = await kbps()
  }
  t.diagnostic('throughput over the local testnet: ' + value + ' kbps')
  assert.ok(Number.isInteger(value) && value > 0, 'measured on streams: ' + value)
  await noLeaks(c, src.id)
})

test('offline source: 503 after the 6 s wait; removing sources: revoked when reachable, quickly when not; principal moves', async (t) => {
  const offlineKey = crypto.randomBytes(32).toString('hex')
  const offlineId = offlineKey.slice(0, 8)
  const seed = crypto.randomBytes(32).toString('hex')
  const c = await startCore(t, { state: { clientSeed: seed, sources: [{ id: offlineId, name: 'Spenta', serverPublicKey: offlineKey, principal: true, addedAt: 1000 }] } })
  assert.equal(c.core.state().publicKey.length, 64)

  const started = Date.now()
  const off = await request(c.port, 'GET', '/s/' + offlineId + '/api/health', { timeout: 20000 })
  const waited = Date.now() - started
  assert.equal(off.status, 503)
  assert.deepEqual(json(off), { error: 'Fonte non raggiungibile' })
  assert.ok(waited >= 5800 && waited < 9000, 'waited ' + waited + ' ms for the link')
  const listed = json(await request(c.port, 'GET', '/local/sources')).sources[0]
  assert.equal(listed.connected, false)
  assert.equal(listed.rttMs, null)
  assert.equal(listed.throughputKbps, null)
  assert.ok(listed.lastError === null || ['spenta o senza rete', 'collegamento interrotto', 'collegamento non riuscito'].includes(listed.lastError), String(listed.lastError))

  const src = await addEcho(c, 'Eco')
  assert.equal(src.principal, false, 'the first added stays principal')

  // The reachable one: it is asked to forget this device first.
  const revokedBefore = echo.revoked.length
  const del = await request(c.port, 'DELETE', '/local/sources/' + src.id)
  assert.equal(del.status, 200)
  assert.deepEqual(json(del), { ok: true, revoked: true })
  assert.equal(echo.revoked.length, revokedBefore + 1)
  assert.equal(rawHeaderMap(echo.revoked[echo.revoked.length - 1].rawHeaders).find(([n]) => n === 'Host')[1], '127.0.0.1')
  assert.equal((await request(c.port, 'GET', '/s/' + src.id + '/echo')).status, 404)
  assert.deepEqual(c.readState().sources.map((s) => s.id), [offlineId])

  // The unreachable one: forgotten after the 2 s attempt; no principal left to move.
  const t0 = Date.now()
  const del2 = await request(c.port, 'DELETE', '/local/sources/' + offlineId)
  const took = Date.now() - t0
  assert.deepEqual(json(del2), { ok: true, revoked: false })
  assert.ok(took < 4500, 'took ' + took + ' ms')
  assert.deepEqual(c.readState().sources, [])
  assert.deepEqual(json(await request(c.port, 'GET', '/local/sources')), { sources: [] })
  assert.deepEqual(c.events[c.events.length - 1], { type: 'sources', sources: [] })
  assert.equal((await request(c.port, 'DELETE', '/local/sources/' + offlineId)).status, 404)
})

test('adding a source again while it is being removed: the removal ends first, then it is paired again and added anew', async (t) => {
  const c = await startCore(t, { revokeTimeoutMs: 10000 })
  const src = await addEcho(c)
  const me = c.core.state().publicKey
  // The source holds its answer to "forget this device" until the next pairing,
  // so the add below is paired exactly while the removal waits, and the source
  // forgets the device AFTER admitting it again (the worst order).
  const released = echo.holdNextRevoke(8000)
  const revokedBefore = echo.revoked.length
  const del = request(c.port, 'DELETE', '/local/sources/' + src.id, { timeout: 30000 })
  await waitFor(() => echo.revoked.length > revokedBefore, { timeout: 10000, what: 'the removal asking the source' })
  const add = await request(c.port, 'POST', '/local/sources', { body: { code: echo.code, name: 'Di nuovo' }, timeout: 60000 })
  assert.equal(await released, 'paired', 'the pairing happened while the removal waited')
  assert.deepEqual(json(await del), { ok: true, revoked: true })
  assert.equal(add.status, 201, 'added anew, not "already there" for a source on its way out: ' + add.body)
  assert.equal(json(add).source.name, 'Eco')
  assert.deepEqual(json(await request(c.port, 'GET', '/local/sources')).sources.map((s) => s.id), [src.id])
  assert.deepEqual(c.readState().sources.map((s) => [s.id, s.name]), [[src.id, 'Eco']])
  assert.equal(echo.allowed.get(me), 'Banco di prova', 'admitted again after the source forgot it')
  await waitFor(() => c.core.state().sources[0]?.connected, { timeout: 15000, what: 'the new link up' })
  assert.equal((await request(c.port, 'GET', '/s/' + src.id + '/echo')).status, 200)
})

test('principal moves to the oldest remaining source when the principal is removed', async (t) => {
  const seed = crypto.randomBytes(32).toString('hex')
  const keys = [1, 2, 3].map(() => crypto.randomBytes(32).toString('hex'))
  const sources = keys.map((k, i) => ({ id: k.slice(0, 8), name: 'F' + i, serverPublicKey: k, principal: i === 1, addedAt: 1000 + i }))
  const c = await startCore(t, { state: { clientSeed: seed, sources } })
  const res = await request(c.port, 'DELETE', '/local/sources/' + sources[1].id)
  assert.equal(res.status, 200)
  assert.deepEqual(c.readState().sources.map((s) => [s.name, s.principal]), [['F0', true], ['F2', false]])
  const p = await request(c.port, 'PATCH', '/local/sources/' + sources[2].id, { body: { principal: true } })
  assert.equal(p.status, 200)
  assert.deepEqual(c.readState().sources.map((s) => [s.name, s.principal]), [['F0', false], ['F2', true]])
})

test('request heads at the socket: byte by byte, timeout, too large, malformed, closed early, HTTP/1.0', async (t) => {
  const c = await startCore(t, { headTimeoutMs: 2500 })
  const head = 'GET /local/sources HTTP/1.1\r\nHost: 127.0.0.1:' + c.port + '\r\n\r\n'
  const slow = await raw(c.port, [...head].map((ch) => ch), { delay: 1 })
  assert.deepEqual(JSON.parse(parsed(slow).body), { sources: [] })

  const t0 = Date.now()
  const silent = await raw(c.port, 'GET / HTTP/1.1\r\nHost: 127.0.0.1:' + c.port + '\r\n')
  assert.equal(silent.length, 0, 'no answer to an incomplete head')
  assert.ok(Date.now() - t0 < 6000)

  const huge = await raw(c.port, 'GET / HTTP/1.1\r\nHost: 127.0.0.1:' + c.port + '\r\nX-Big: ' + 'a'.repeat(40000) + '\r\n\r\n')
  assert.equal(parsed(huge).status, 431)
  const endless = await raw(c.port, ['GET / HTTP/1.1\r\n', 'X-A: ' + 'b'.repeat(33000)])
  assert.equal(parsed(endless).status, 431, 'a head that never ends is cut at 32 KB')

  const malformed = await raw(c.port, 'GET / HTTP/1.1\r\nHost : x\r\n\r\n')
  assert.equal(parsed(malformed).status, 400)
  assert.deepEqual(JSON.parse(parsed(malformed).body), { error: 'Richiesta non valida' })
  assert.equal(parsed(await raw(c.port, 'GET / HTTP/3.0\r\nHost: 127.0.0.1:' + c.port + '\r\n\r\n')).status, 505)
  assert.equal(parsed(await raw(c.port, 'POST /local/sources HTTP/1.1\r\nHost: 127.0.0.1:' + c.port + '\r\nTransfer-Encoding: chunked\r\nContent-Length: 3\r\n\r\nabc')).status, 400)

  const early = await raw(c.port, 'GET /loc', { end: true })
  assert.equal(early.length, 0)

  const old = await raw(c.port, 'GET /local/sources HTTP/1.0\r\n\r\n', { end: true })
  assert.equal(parsed(old).status, 200, 'HTTP/1.0 without Host, half-closed after the request')

  // A body announced but never sent, on a request the core answers itself, then gone.
  await raw(c.port, 'POST /local/sources HTTP/1.1\r\nHost: 127.0.0.1:' + c.port + '\r\nContent-Length: 50\r\n\r\n{"co', { end: true })
  await waitFor(() => c.core.state().connections === 0, { timeout: 5000, what: 'connections closed' })
})

test('state file: created with a seed (0600), replaced by rename and never written in place, a failed write changes nothing, an unreadable file is set aside', async (t) => {
  const c = await startCore(t)
  const first = c.readState()
  assert.match(first.clientSeed, /^[0-9a-f]{64}$/)
  if (process.platform !== 'win32') assert.equal(fs.statSync(c.statePath).mode & 0o777, 0o600)
  await c.core.stop()

  // A source written while stopped (a state from before profiles), then the
  // profile made and renamed through the API.
  const key = crypto.randomBytes(32).toString('hex')
  fs.writeFileSync(c.statePath, JSON.stringify({ clientSeed: first.clientSeed, sources: [{ id: key.slice(0, 8), name: 'Vecchio', serverPublicKey: key, principal: true, addedAt: 5 }] }, null, 2) + '\n')
  const c2 = await startCore(t, { state: fs.readFileSync(c.statePath, 'utf8') })
  assert.equal(c2.core.state().publicKey, c.core.state().publicKey, 'same seed, same identity')
  assert.deepEqual(c2.readState().sources, [{ id: key.slice(0, 8), name: 'Vecchio', serverPublicKey: key, principal: true, addedAt: 5, role: null, named: null, profiles: null, social: null, card: null }])
  assert.equal(c2.readState().profile, null)
  const ino = fs.statSync(c2.statePath).ino
  const res = await request(c2.port, 'POST', '/local/profile', { body: { name: 'Nuovo' } })
  assert.equal(res.status, 201)
  assert.equal(c2.readState().profile.name, 'Nuovo')
  assert.notEqual(fs.statSync(c2.statePath).ino, ino, 'a new file renamed over the old one')
  assert.deepEqual(fs.readdirSync(c2.dir), ['state.json'], 'no temporary file left')
  if (process.platform !== 'win32') assert.equal(fs.statSync(c2.statePath).mode & 0o777, 0o600)

  // The temporary file cannot be written: the request fails, file and memory unchanged.
  const before = fs.readFileSync(c2.statePath)
  fs.mkdirSync(c2.statePath + '.tmp')
  const failed = await request(c2.port, 'PATCH', '/local/profile', { body: { name: 'Mai' } })
  assert.equal(failed.status, 500)
  assert.deepEqual(json(failed), { error: 'Qualcosa non ha funzionato', code: 'failed' })
  assert.ok(fs.readFileSync(c2.statePath).equals(before), 'the state file is untouched')
  assert.equal(json(await request(c2.port, 'GET', '/local/profile')).profile.name, 'Nuovo', 'and so is the state in memory')
  fs.rmdirSync(c2.statePath + '.tmp')
  assert.equal((await request(c2.port, 'PATCH', '/local/profile', { body: { name: 'Dopo' } })).status, 200)
  assert.equal(c2.readState().profile.name, 'Dopo')

  // Concurrent changes are written one at a time; the last one wins on disk too.
  const names = Array.from({ length: 12 }, (_, i) => 'Nome ' + i)
  await Promise.all(names.map((name) => request(c2.port, 'PATCH', '/local/profile', { body: { name } })))
  const final = json(await request(c2.port, 'GET', '/local/profile')).profile.name
  assert.ok(names.includes(final))
  assert.equal(c2.readState().profile.name, final)

  // An unreadable state file is set aside, a new identity begins.
  const c3 = await startCore(t, { state: '{"clientSeed": "trunc' })
  const aside = fs.readdirSync(c3.dir).filter((f) => f.startsWith('state.json.corrupt-'))
  assert.equal(aside.length, 1)
  assert.equal(fs.readFileSync(path.join(c3.dir, aside[0]), 'utf8'), '{"clientSeed": "trunc')
  assert.match(c3.readState().clientSeed, /^[0-9a-f]{64}$/)
  assert.ok(c3.logs.some((l) => l.includes('set aside')))

  // A state saved with a byte order mark in front (an editor, PowerShell 5.1's
  // Set-Content -Encoding utf8) is the same state: same identity, same sources.
  const bomSeed = crypto.randomBytes(32).toString('hex')
  const bomKey = crypto.randomBytes(32).toString('hex')
  const c4 = await startCore(t, { state: '\ufeff' + JSON.stringify({ clientSeed: bomSeed, sources: [{ id: bomKey.slice(0, 8), name: 'Con BOM', serverPublicKey: bomKey, principal: true, addedAt: 7 }] }, null, 2) + '\n' })
  assert.deepEqual(fs.readdirSync(c4.dir), ['state.json'], 'nothing set aside')
  assert.equal(c4.core.state().publicKey, keyPairFromSeed(bomSeed).publicKey, 'the same identity')
  assert.deepEqual(c4.core.state().sources.map((s) => [s.id, s.name]), [[bomKey.slice(0, 8), 'Con BOM']])
  assert.ok(!c4.logs.some((l) => l.includes('set aside')))
})

test('stop closes the port and is idempotent; a busy port makes start fail', async (t) => {
  const c = await startCore(t)
  const dir = tmpDir('mpfy-cc-busy-')
  const other = createClientCore({ statePath: path.join(dir, 'state.json'), webRoot: WEB, port: c.port, dht: node() })
  await assert.rejects(other.start(), (err) => err.code === 'EADDRINUSE')
  await other.stop()
  rmDir(dir)
  assert.equal((await request(c.port, 'GET', '/local/sources')).status, 200, 'the first one is unaffected')
  await c.core.stop()
  await c.core.stop()
  assert.equal(c.core.state().running, false)
  await assert.rejects(request(c.port, 'GET', '/'), (err) => err.code === 'ECONNREFUSED')
})

// ------------------------------------------------------------------ client-node: one client per state file

test('client-node: one client per state file; "add" goes through the running one whatever its port, so nothing it adds is lost', async (t) => {
  const dir = tmpDir('mpfy-cc-lock-')
  const statePath = path.join(dir, 'state.json')
  let running = null
  t.after(async () => {
    if (running) await running.stop()
    rmDir(dir)
  })
  running = (await runClient({ statePath, webRoot: WEB, port: 0, dht: node() })).core
  const port = running.state().port
  const lock = JSON.parse(fs.readFileSync(lockPathOf(statePath), 'utf8'))
  assert.equal(lock.pid, process.pid)
  assert.equal(lock.port, port)
  assert.equal(lock.role, 'run')

  // A second client on the same state file is refused, whatever its port.
  await assert.rejects(runClient({ statePath, webRoot: WEB, port: 0, dht: node() }), (err) => err.code === 'LOCKED' && err.message === 'MPfy è già aperto: http://127.0.0.1:' + port + '/')

  // "add" finds the running client through the lock, not through a port of its
  // own (it was 47123 by default, while this one runs elsewhere): the running core
  // adds the source, so its next write of the state keeps it.
  const id = echo.publicKey.slice(0, 8)
  const added = await addSource({ code: echo.code, name: 'Eco', statePath, webRoot: WEB, dht: node() })
  assert.equal(added.via, 'running')
  assert.equal(added.source.id, id)
  assert.deepEqual(running.state().sources.map((s) => s.id), [id])
  assert.equal((await request(port, 'POST', '/local/profile', { body: { name: 'Banco' } })).status, 201)
  const written = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  assert.equal(written.profile.name, 'Banco')
  assert.deepEqual(written.sources.map((s) => [s.id, s.name]), [[id, 'Eco']], 'the added source survives the running client\'s next write')

  // Stopped, the lock goes; "add" then runs a core of its own, holding the lock
  // meanwhile (a client started then is refused), and lets it go.
  await running.stop()
  running = null
  assert.equal(fs.existsSync(lockPathOf(statePath)), false)
  const held = echo.holdNextPairing()
  const pending = addSource({ code: echo.code, statePath, webRoot: WEB, dht: node() })
  pending.catch(() => {})
  await held.reached // the temporary core is up and pairing
  const addLock = JSON.parse(fs.readFileSync(lockPathOf(statePath), 'utf8'))
  assert.equal(addLock.role, 'add')
  assert.ok(addLock.port > 0)
  await assert.rejects(runClient({ statePath, webRoot: WEB, port: 0, dht: node() }), (err) => err.code === 'LOCKED' && err.message === 'un\'altra fonte è in aggiunta: riprova tra poco')
  held.release()
  const again = await pending
  assert.equal(again.via, 'temporary')
  assert.equal(again.source.id, id, 'already there: kept')
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).profile.name, 'Banco', 'and the profile with it')
  assert.equal(fs.existsSync(lockPathOf(statePath)), false, 'released after the add')
  assert.deepEqual(fs.readdirSync(dir).sort(), ['state.json'])
})

test('client-node profile: new, show, export to a file, import from that file and from a code; through a core for the moment or the running one', async (t) => {
  const base = tmpDir('mpfy-cc-cli-profile-')
  t.after(() => rmDir(base))
  const place = (name) => {
    const dir = path.join(base, name)
    fs.mkdirSync(dir)
    return { statePath: path.join(dir, 'state.json'), webRoot: WEB, cwd: dir, dir }
  }
  const pc = place('pc')
  assert.deepEqual(await profileCommand([], { ...pc, dht: node() }), ['Nessun profilo su questo PC'])
  assert.equal(fs.existsSync(lockPathOf(pc.statePath)), false, 'the lock of the core for the moment is gone')
  const made = await profileCommand(['new', 'Bacca', 'dal', 'PC'], { ...pc, dht: node() })
  const id = JSON.parse(fs.readFileSync(pc.statePath, 'utf8')).profile.id
  assert.deepEqual(made, ['Profilo creato: Bacca dal PC (' + id + ')'])
  await assert.rejects(profileCommand(['new', 'Altro'], { ...pc, dht: node() }), (err) => err.code === 'profile_exists' && err.message === 'Profilo gi\u00e0 presente')
  await assert.rejects(profileCommand(['boh'], { ...pc, dht: node() }), /^Error: uso: /)

  // Through the running client, whatever its port.
  const running = (await runClient({ statePath: pc.statePath, webRoot: WEB, port: 0, dht: node() })).core
  assert.deepEqual(await profileCommand([], { ...pc, dht: node() }), ['Profilo: Bacca dal PC (' + id + ')', 'Recupero con password: disattivato'])
  const saved = await profileCommand(['export'], { ...pc, dht: node() })
  const file = path.join(pc.dir, 'Bacca dal PC.mpfy')
  assert.deepEqual(saved, ['Profilo salvato in ' + file, 'Contiene l\'accesso alle tue fonti: tienilo per te.'])
  await running.stop()
  const text = fs.readFileSync(file, 'utf8')
  assert.ok(text.endsWith('}\n') && text.includes('\n  "format": "mpfy-identity",\n'), 'pretty printed, final newline')
  assert.equal(parseIdentity(text).profile.id, id)
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.deepEqual(fs.readdirSync(pc.dir).sort(), ['Bacca dal PC.mpfy', 'state.json'])

  // Another PC from that file: the same device and profile.
  const other = place('other')
  assert.deepEqual(await profileCommand(['import', '../pc/Bacca dal PC.mpfy'], { ...other, dht: node() }), ['Profilo: Bacca dal PC (' + id + ')', 'Fonti: 0'])
  const before = JSON.parse(fs.readFileSync(pc.statePath, 'utf8'))
  const after = JSON.parse(fs.readFileSync(other.statePath, 'utf8'))
  assert.equal(after.clientSeed, before.clientSeed)
  assert.equal(after.profile.secret, before.profile.secret)

  // A third one from the code, typed in pieces: the profile only.
  const third = place('third')
  const code = formatProfileCode(before.profile.secret)
  assert.deepEqual(await profileCommand(['import', ...code.split('-')], { ...third, dht: node() }), ['Profilo: (senza nome) (' + id + ')', 'Fonti: 0'])
  assert.notEqual(JSON.parse(fs.readFileSync(third.statePath, 'utf8')).clientSeed, before.clientSeed)
  const fourth = place('fourth')
  await assert.rejects(profileCommand(['import', 'nessun-file.mpfy'], { ...fourth, dht: node() }), (err) => err.code === 'bad_code')

  // The code read from the input, so it never stays in the shell's history: the
  // command alone, or '-'. Only the first line counts.
  for (const args of [['import'], ['import', '-']]) {
    const here = place('input' + args.length)
    const stdin = Readable.from([code.toLowerCase().replace(/-/g, ' ') + '\r\naltro\n'])
    assert.deepEqual(await profileCommand(args, { ...here, stdin, dht: node() }), ['Profilo: (senza nome) (' + id + ')', 'Fonti: 0'], args.join(' '))
    assert.equal(JSON.parse(fs.readFileSync(here.statePath, 'utf8')).profile.secret, before.profile.secret)
  }
  const wrong = place('input-wrong')
  await assert.rejects(profileCommand(['import'], { ...wrong, stdin: Readable.from(['MPFY-P-1234\n']), dht: node() }), (err) => err.code === 'bad_code')
  const empty = place('input-empty')
  await assert.rejects(profileCommand(['import', '-'], { ...empty, stdin: Readable.from(['\n']), dht: node() }), /^Error: uso: /)
  assert.equal(fs.existsSync(empty.statePath), false, 'nothing started for an empty line')
})

// client-node as a person runs it, through the client holding `statePath`: its
// exit code and everything it printed.
function exportWithCli (file, { cwd, statePath }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLIENT_NODE, 'profile', 'export', file], {
      cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MPFY_CLIENT_STATE: statePath, MPFY_CLIENT_PORT: '' }
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (c) => { stdout += c })
    child.stderr.setEncoding('utf8').on('data', (c) => { stderr += c })
    const timer = setTimeout(() => child.kill(), 60000)
    child.on('close', (status) => {
      clearTimeout(timer)
      resolve({ status, stdout, stderr })
    })
  })
}

const savedLines = (file) => ['Profilo salvato in ' + file, 'Contiene l\'accesso alle tue fonti: tienilo per te.']
// What a folder holds, leaving out the files of the core that keeps its state there.
const filesIn = (dir) => fs.readdirSync(dir).filter((n) => !n.startsWith('state.json')).sort()

test('client-node profile export: a folder that is not there is named and never made, also when typed as a folder; a folder that is there gets the file named after the profile; exit 1, never the system\'s text, nothing left behind', async (t) => {
  const base = tmpDir('mpfy-cc-cli-export-')
  let running = null
  t.after(async () => {
    if (running !== null) await running.stop()
    rmDir(base)
  })
  const statePath = path.join(base, 'state.json')
  await profileCommand(['new', 'Bacca'], { statePath, webRoot: WEB, cwd: base, dht: node() })
  // Told before anything starts: no core for the moment is started for it.
  let started = false
  const spy = { on () { started = true }, off () {} }
  const nuova = path.join(base, 'nuova')
  for (const what of [path.join(nuova, 'Bacca.mpfy'), 'nuova' + path.sep, 'nuova/', nuova + path.sep]) {
    await assert.rejects(profileCommand(['export', what], { statePath, webRoot: WEB, cwd: base, dht: spy }),
      (err) => err.message === 'la cartella non esiste: ' + nuova, what)
  }
  assert.equal(started, false)
  assert.deepEqual(fs.readdirSync(base).sort(), ['state.json'], 'nothing made')

  // The command goes through the running client, so it needs no network of its own.
  running = (await runClient({ statePath, webRoot: WEB, port: 0, dht: node() })).core
  const opts = { statePath, webRoot: WEB, cwd: base, dht: node() }
  // The file named after the profile, in a folder that is not there.
  const gone = path.join(base, 'sparita')
  await assert.rejects(profileCommand(['export'], { ...opts, cwd: gone }), (err) => err.message === 'la cartella non esiste: ' + gone)
  assert.equal(fs.existsSync(gone), false)

  // A folder that is there, however it is typed: the file goes in it.
  const esiste = path.join(base, 'esiste')
  fs.mkdirSync(esiste)
  const inside = path.join(esiste, 'Bacca.mpfy')
  for (const what of ['esiste', 'esiste' + path.sep, esiste + '/', '.' + path.sep + 'esiste']) {
    assert.deepEqual(await profileCommand(['export', what], opts), savedLines(inside), what)
    assert.equal(parseIdentity(fs.readFileSync(inside, 'utf8')).profile.name, 'Bacca')
    assert.deepEqual(fs.readdirSync(esiste), ['Bacca.mpfy'], what)
    fs.unlinkSync(inside)
  }
  assert.deepEqual(await profileCommand(['export', '.'], { ...opts, cwd: esiste }), savedLines(inside))
  fs.unlinkSync(inside)

  const before = filesIn(base)
  const missing = path.join(base, 'nuova', 'sotto')
  const r1 = await exportWithCli(path.join(missing, 'Bacca.mpfy'), { cwd: base, statePath })
  assert.deepEqual(r1, { status: 1, stdout: '', stderr: 'Errore: la cartella non esiste: ' + missing + '\n' })
  const r2 = await exportWithCli(nuova + path.sep, { cwd: base, statePath })
  assert.deepEqual(r2, { status: 1, stdout: '', stderr: 'Errore: la cartella non esiste: ' + nuova + '\n' })
  assert.equal(fs.existsSync(nuova), false, 'no folder made, and no file by its name')
  assert.deepEqual(filesIn(base), before, 'nothing written')

  const ok = path.join(base, 'Bacca.mpfy')
  const r3 = await exportWithCli(ok, { cwd: base, statePath })
  assert.equal(r3.status, 0, r3.stderr)
  assert.equal(r3.stdout, savedLines(ok).join('\n') + '\n')
  assert.equal(parseIdentity(fs.readFileSync(ok, 'utf8')).profile.name, 'Bacca')
})

test('client-node profile export: a file that cannot be written stays as it is, also in a folder that can be (a rename alone would replace it), and so does a folder that cannot be written; exit 1, never the system\'s text, nothing left behind', async (t) => {
  const base = tmpDir('mpfy-cc-cli-readonly-')
  const target = path.join(base, 'Bacca.mpfy')
  const locked = path.join(base, 'locked')
  let running = null
  t.after(async () => {
    if (running !== null) await running.stop()
    for (const p of [target, locked]) {
      try {
        fs.chmodSync(p, 0o755)
      } catch {}
    }
    rmDir(base)
  })
  if (process.platform !== 'win32' && process.getuid() === 0) {
    t.skip('root writes anyway')
    return
  }
  const statePath = path.join(base, 'state.json')
  await profileCommand(['new', 'Bacca'], { statePath, webRoot: WEB, cwd: base, dht: node() })
  running = (await runClient({ statePath, webRoot: WEB, port: 0, dht: node() })).core
  const opts = { statePath, webRoot: WEB, cwd: base, dht: node() }
  const refused = (file) => (err) => err.message === 'impossibile scrivere ' + file

  // Read-only, in a folder that can be written.
  fs.writeFileSync(target, 'vecchio\n')
  fs.chmodSync(target, 0o444)
  const r1 = await exportWithCli(target, { cwd: base, statePath })
  assert.deepEqual(r1, { status: 1, stdout: '', stderr: 'Errore: impossibile scrivere ' + target + '\n' })
  assert.equal(fs.readFileSync(target, 'utf8'), 'vecchio\n', 'the old file untouched')
  assert.deepEqual(filesIn(base), ['Bacca.mpfy'], 'no temporary file left')
  fs.chmodSync(target, 0o644)

  // Windows: no read-only flag, but writing it is denied to everyone.
  if (process.platform === 'win32') {
    const r = spawnSync('icacls', [target, '/deny', '*S-1-1-0:(WD,AD)'], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.throws(() => fs.appendFileSync(target, 'x'), (err) => err.code === 'EPERM')
    await assert.rejects(profileCommand(['export', target], opts), refused(target))
    assert.equal(fs.readFileSync(target, 'utf8'), 'vecchio\n', 'the old file untouched')
    assert.deepEqual(filesIn(base), ['Bacca.mpfy'], 'no temporary file left')
  }

  // A folder that cannot be written (on Windows its read-only flag stops nobody).
  if (process.platform !== 'win32') {
    fs.mkdirSync(locked)
    fs.chmodSync(locked, 0o555)
    const inLocked = path.join(locked, 'Bacca.mpfy')
    await assert.rejects(profileCommand(['export', inLocked], opts), refused(inLocked))
    assert.deepEqual(fs.readdirSync(locked), [], 'nothing left behind')
  }
})

test('client-node profile export: the temporary file is always a new one of its own, never one already at its name; a write that fails halfway leaves nothing behind', async (t) => {
  const base = tmpDir('mpfy-cc-cli-tmp-')
  let running = null
  const writeFileSync = fs.writeFileSync
  const undo = []
  t.after(async () => {
    fs.writeFileSync = writeFileSync
    if (running !== null) await running.stop()
    for (const args of undo) spawnSync('icacls', args)
    rmDir(base)
  })
  const statePath = path.join(base, 'state.json')
  await profileCommand(['new', 'Bacca'], { statePath, webRoot: WEB, cwd: base, dht: node() })
  running = (await runClient({ statePath, webRoot: WEB, port: 0, dht: node() })).core
  const opts = { statePath, webRoot: WEB, cwd: base, dht: node() }
  const target = path.join(base, 'Bacca.mpfy')
  const tmp = target + '.' + process.pid + '.tmp'

  // Another name for someone else's file, where the temporary one goes.
  const other = path.join(base, 'altro')
  fs.writeFileSync(other, 'altro\n', { mode: 0o644 })
  fs.linkSync(other, tmp)
  assert.deepEqual(await profileCommand(['export', target], opts), savedLines(target))
  assert.equal(fs.readFileSync(other, 'utf8'), 'altro\n', 'never written through')
  assert.equal(parseIdentity(fs.readFileSync(target, 'utf8')).profile.name, 'Bacca')
  if (process.platform !== 'win32') assert.equal(fs.statSync(target).mode & 0o777, 0o600)
  assert.deepEqual(filesIn(base), ['Bacca.mpfy', 'altro'])

  // Windows: one there that cannot be taken away (someone else's, in a folder
  // shared with them) is refused, never written through.
  if (process.platform === 'win32') {
    const shared = path.join(base, 'condivisa')
    fs.mkdirSync(shared)
    const there = path.join(shared, 'Bacca.mpfy')
    const theirs = there + '.' + process.pid + '.tmp'
    fs.writeFileSync(theirs, 'loro\n')
    for (const [p, deny] of [[theirs, '*S-1-1-0:(DE)'], [shared, '*S-1-1-0:(DC)']]) {
      const r = spawnSync('icacls', [p, '/deny', deny], { encoding: 'utf8' })
      assert.equal(r.status, 0, r.stdout + r.stderr)
      undo.unshift([p, '/remove:d', '*S-1-1-0'])
    }
    assert.throws(() => fs.unlinkSync(theirs), (err) => err.code === 'EPERM')
    await assert.rejects(profileCommand(['export', there], opts), (err) => err.message === 'impossibile scrivere ' + there)
    assert.equal(fs.readFileSync(theirs, 'utf8'), 'loro\n', 'never written through')
    assert.deepEqual(fs.readdirSync(shared), [path.basename(theirs)])
  }

  // The disk gives up once the file is made (a full or failing stick).
  const kept = fs.readFileSync(target, 'utf8')
  const before = filesIn(base)
  fs.writeFileSync = function (file, data, ...more) {
    if (file !== tmp) return writeFileSync.call(this, file, data, ...more)
    writeFileSync.call(this, file, String(data).slice(0, 40), ...more)
    const err = new Error('EIO: i/o error, write')
    err.code = 'EIO'
    throw err
  }
  await assert.rejects(profileCommand(['export', target], opts), (err) => err.message === 'impossibile scrivere ' + target)
  fs.writeFileSync = writeFileSync
  assert.equal(fs.readFileSync(target, 'utf8'), kept, 'the file there untouched')
  assert.deepEqual(filesIn(base), before, 'nothing left behind')
})

test('client-node: a lock left behind is taken over (process gone, pid reused, died while starting), a fresh one is not', async (t) => {
  const dir = tmpDir('mpfy-cc-stale-')
  const statePath = path.join(dir, 'state.json')
  const lockFile = lockPathOf(statePath)
  t.after(() => rmDir(dir))
  const takesOver = async (what) => {
    const { core } = await runClient({ statePath, webRoot: WEB, port: 0, dht: node() })
    assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).port, core.state().port, what)
    await core.stop()
    assert.equal(fs.existsSync(lockFile), false, what + ': released')
  }
  const refused = (message) => assert.rejects(runClient({ statePath, webRoot: WEB, port: 0, dht: node() }), (err) => err.code === 'LOCKED' && err.message === message)

  // The process is gone (a window closed, a crash).
  const gone = spawnSync(process.execPath, ['-e', ''])
  fs.writeFileSync(lockFile, JSON.stringify({ pid: gone.pid, port: 47999, role: 'run', nonce: 'a' }))
  await takesOver('process gone')
  // The pid is alive (reused by another program) but nothing listens on the port.
  const probe = net.createServer()
  const freePort = await listenServer(probe)
  await closeServer(probe)
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, port: freePort, role: 'run', nonce: 'b' }))
  await takesOver('pid reused')
  // Starting (no port yet): held while young, taken over once old.
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, port: null, role: 'run', nonce: 'c' }))
  await refused('MPfy si sta avviando: riprova tra poco')
  const old = (Date.now() - LOCK_STARTING_MS - 5000) / 1000
  fs.utimesSync(lockFile, old, old)
  await takesOver('died while starting')
  // Empty: being written this very instant.
  fs.writeFileSync(lockFile, '')
  await refused('MPfy si sta avviando: riprova tra poco')
  fs.utimesSync(lockFile, old, old)
  await takesOver('empty and old')
  // A lock taken over by another client meanwhile is not removed by the old one.
  const { core, lock } = await runClient({ statePath, webRoot: WEB, port: 0, dht: node() })
  const other = JSON.stringify({ pid: process.pid, port: core.state().port, role: 'run', nonce: 'someone-else' })
  fs.writeFileSync(lockFile, other)
  await core.stop()
  assert.equal(fs.readFileSync(lockFile, 'utf8'), other)
  assert.equal(lock.released, true)
})
