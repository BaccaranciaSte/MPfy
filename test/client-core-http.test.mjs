// Client core, pure pieces: the request-head parser (findHeadEnd, parseRequestHead),
// the chunked decoder, the head forwarded to a source, the ETag comparison, the
// throughput meter (alone and fed by the forwarder), the state normalization.

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Duplex } from 'streamx'
import {
  findHeadEnd, parseRequestHead, ChunkedDecoder, buildForwardHead, splitSourceTarget, etagMatches,
  responseHead, HttpError, MAX_HEAD_BYTES
} from '../client-core/http.js'
import { ThroughputMeter } from '../client-core/meter.js'
import { pipeForward } from '../client-core/forward.js'
import { normalizeState, cleanName, defaultSocial } from '../client-core/state.js'
import { linkErrorWords } from '../client-core/index.js'

const B = (s) => Buffer.from(s, 'latin1')

function parse (text) {
  const buf = B(text)
  const { start, end } = findHeadEnd(buf)
  assert.notEqual(end, -1, 'head complete')
  return parseRequestHead(buf, start, end)
}

function rejects (text, status) {
  assert.throws(() => parse(text), (err) => err instanceof HttpError && err.status === status, JSON.stringify(text))
}

test('head end: CRLF, bare LF, leading empty lines, incomplete, resumed search', () => {
  assert.deepEqual(findHeadEnd(B('GET / HTTP/1.1\r\nHost: a\r\n\r\nBODY')), { start: 0, end: 27 })
  assert.deepEqual(findHeadEnd(B('GET / HTTP/1.1\nHost: a\n\nBODY')), { start: 0, end: 24 })
  assert.deepEqual(findHeadEnd(B('\r\n\r\nGET / HTTP/1.1\r\nHost: a\r\n\r\n')), { start: 4, end: 31 })
  assert.equal(findHeadEnd(B('GET / HTTP/1.1\r\nHost: a\r\n')).end, -1)
  assert.equal(findHeadEnd(B('GET / HTTP/1.1\r\nHost: a\r\n\r')).end, -1)
  assert.equal(findHeadEnd(B('\r\n\r\n')).end, -1, 'only empty lines: still waiting for a request line')
  // Byte by byte, resuming where the previous search stopped, finds the same end.
  const full = B('PUT /x HTTP/1.1\r\nHost: a\r\nContent-Length: 3\r\n\r\nabc')
  let found = null
  for (let n = 1; n <= full.length && found === null; n++) {
    const r = findHeadEnd(full.subarray(0, n), Math.max(0, n - 1 - 3))
    if (r.end !== -1) found = r
  }
  assert.deepEqual(found, findHeadEnd(full))
})

test('head parse: request line, fields, map, framing', () => {
  const r = parse('POST /local/sources?x=1 HTTP/1.1\r\nHost: 127.0.0.1:47123\r\nX-A: 1\r\nx-a:  2 \r\nContent-Length: 12\r\nExpect: 100-continue\r\n\r\n')
  assert.equal(r.method, 'POST')
  assert.equal(r.target, '/local/sources?x=1')
  assert.equal(r.path, '/local/sources')
  assert.equal(r.query, '?x=1')
  assert.equal(r.version, 'HTTP/1.1')
  assert.deepEqual(r.headers.slice(1, 3), [['X-A', '1'], ['x-a', '2']])
  assert.equal(r.map['x-a'], '1, 2')
  assert.equal(r.body, 'length')
  assert.equal(r.contentLength, 12)
  assert.equal(r.expectContinue, true)

  const c = parse('PUT /s/abcd1234/api/upload/a.wav HTTP/1.1\r\nHost: h\r\nTransfer-Encoding: Chunked\r\n\r\n')
  assert.equal(c.body, 'chunked')
  const z = parse('POST / HTTP/1.1\r\nHost: h\r\nContent-Length: 0\r\n\r\n')
  assert.equal(z.body, 'none')
  const same = parse('POST / HTTP/1.1\r\nHost: h\r\nContent-Length: 5\r\nContent-Length: 5\r\n\r\n')
  assert.equal(same.contentLength, 5, 'repeated identical Content-Length is one length')
  const old = parse('GET / HTTP/1.0\r\n\r\n')
  assert.equal(old.version, 'HTTP/1.0')
  assert.equal(old.map.host, undefined, 'HTTP/1.0 may omit Host')
  const lf = parse('GET /a HTTP/1.1\nHost: h\n\n')
  assert.equal(lf.map.host, 'h')
  const tab = parse('GET / HTTP/1.1\r\nHost: h\r\nX:\tv\tw\t\r\n\r\n')
  assert.equal(tab.map.x, 'v\tw')
  const latin = parse('GET / HTTP/1.1\r\nHost: h\r\nX-N: caf\xe9\r\n\r\n')
  assert.equal(latin.map['x-n'], 'caf\xe9', 'obs-text kept as bytes')
})

test('head parse: malformed heads are refused', () => {
  rejects('GET / HTTP/1.1\r\n\r\n', 400) // HTTP/1.1 without Host
  rejects('GET / HTTP/1.1\r\nHost: a\r\nHost: b\r\n\r\n', 400)
  rejects('GET  / HTTP/1.1\r\nHost: a\r\n\r\n', 400) // two spaces
  rejects('GET / HTTP/1.1 \r\nHost: a\r\n\r\n', 400)
  rejects('G(T / HTTP/1.1\r\nHost: a\r\n\r\n', 400) // method not a token
  rejects('GET http://x/ HTTP/1.1\r\nHost: a\r\n\r\n', 400) // absolute-form
  rejects('OPTIONS * HTTP/1.1\r\nHost: a\r\n\r\n', 400)
  rejects('GET /a#b HTTP/1.1\r\nHost: a\r\n\r\n', 400)
  rejects('GET /caf\xe9 HTTP/1.1\r\nHost: a\r\n\r\n', 400)
  rejects('GET / HTTP/2.0\r\nHost: a\r\n\r\n', 505)
  rejects('GET / HTTPS/1.1\r\nHost: a\r\n\r\n', 400)
  rejects('GET / HTTP/1.1\r\nHost : a\r\n\r\n', 400) // whitespace before the colon
  rejects('GET / HTTP/1.1\r\nHost: a\r\n folded\r\n\r\n', 400) // obs-fold
  rejects('GET / HTTP/1.1\r\nHost: a\r\nnocolon\r\n\r\n', 400)
  rejects('GET / HTTP/1.1\r\nHost: a\r\n: v\r\n\r\n', 400)
  rejects('GET / HTTP/1.1\r\nHost: a\rX: b\r\n\r\n', 400) // bare CR
  rejects('GET / HTTP/1.1\r\nHost: a\r\nX: a\x00b\r\n\r\n', 400)
  rejects('GET / HTTP/1.1\r\nHost: a\r\nX: a\x01b\r\n\r\n', 400)
  rejects('POST / HTTP/1.1\r\nHost: a\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n', 400)
  rejects('POST / HTTP/1.1\r\nHost: a\r\nContent-Length: 5\r\nContent-Length: 6\r\n\r\n', 400)
  rejects('POST / HTTP/1.1\r\nHost: a\r\nContent-Length: -1\r\n\r\n', 400)
  rejects('POST / HTTP/1.1\r\nHost: a\r\nContent-Length: 0x10\r\n\r\n', 400)
  rejects('POST / HTTP/1.1\r\nHost: a\r\nContent-Length: 1234567890123456\r\n\r\n', 400)
  rejects('POST / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: gzip, chunked\r\n\r\n', 501)
  rejects('POST / HTTP/1.0\r\nTransfer-Encoding: chunked\r\n\r\n', 400)
  const many = 'GET / HTTP/1.1\r\nHost: a\r\n' + Array.from({ length: 100 }, (_, i) => 'X-' + i + ': v\r\n').join('') + '\r\n'
  rejects(many, 431)
  const big = B('GET / HTTP/1.1\r\nHost: a\r\nX: ' + 'v'.repeat(MAX_HEAD_BYTES) + '\r\n\r\n')
  assert.throws(() => parseRequestHead(big, 0, big.length), (err) => err.status === 431)
})

test('chunked decoder: pieces of any size, extensions, trailers, limits', () => {
  const wire = B('5;ext=1\r\nhello\r\n6\r\n world\r\n0\r\nX-Trailer: 1\r\n\r\nNEXT')
  for (const step of [1, 2, 3, 7, wire.length]) {
    const d = new ChunkedDecoder()
    let used = -1
    let at = 0
    while (at < wire.length && used === -1) {
      const piece = wire.subarray(at, at + step)
      const n = d.push(piece)
      if (n !== -1) used = at + n
      at += step
    }
    assert.equal(d.done, true)
    assert.equal(Buffer.from(d.body).toString(), 'hello world')
    assert.equal(used, wire.length - 4, 'stops right after the body (step ' + step + ')')
  }
  const lf = new ChunkedDecoder()
  assert.notEqual(lf.push(B('3\nabc\n0\n\n')), -1, 'bare LF line ends')
  assert.equal(Buffer.from(lf.body).toString(), 'abc')
  for (const bad of ['x\r\n', '3\r\nabcX\r\n', '-1\r\n', '3 3\r\nabc\r\n', '1234567890123\r\n', '0\r\n bad\r\n\r\n']) {
    assert.throws(() => new ChunkedDecoder().push(B(bad)), (err) => err.status === 400, JSON.stringify(bad))
  }
  assert.throws(() => new ChunkedDecoder({ maxBytes: 4 }).push(B('5\r\nhello\r\n')), (err) => err.status === 413)
})

test('forwarded head: prefix stripped, Host and Connection rewritten, Origin, Referer and hop-by-hop fields removed', () => {
  const r = parse('PUT /s/abcd1234/api/upload/A%20b.wav?q=1 HTTP/1.1\r\n' +
    'Host: 127.0.0.1:47123\r\nOrigin: http://127.0.0.1:47123\r\nReferer: http://127.0.0.1:47123/library\r\n' +
    'Connection: keep-alive, X-Hop, Content-Length\r\nKeep-Alive: timeout=5\r\nX-Hop: 1\r\nUpgrade: websocket\r\nTE: trailers\r\n' +
    'Content-Length: 10\r\nRange: bytes=0-\r\nX-Other: yes\r\n\r\n')
  const fwd = splitSourceTarget(r)
  assert.deepEqual(fwd, { id: 'abcd1234', target: '/api/upload/A%20b.wav?q=1' })
  const head = Buffer.from(buildForwardHead(r, fwd.target)).toString('latin1')
  assert.equal(head,
    'PUT /api/upload/A%20b.wav?q=1 HTTP/1.1\r\nHost: 127.0.0.1:8091\r\n' +
    'Content-Length: 10\r\nRange: bytes=0-\r\nX-Other: yes\r\nConnection: close\r\n\r\n')
  assert.deepEqual(splitSourceTarget(parse('GET /s/abcd1234 HTTP/1.1\r\nHost: h\r\n\r\n')), { id: 'abcd1234', target: '/' })
  assert.deepEqual(splitSourceTarget(parse('GET /s/abcd1234?a=b HTTP/1.1\r\nHost: h\r\n\r\n')), { id: 'abcd1234', target: '/?a=b' })
  assert.deepEqual(splitSourceTarget(parse('GET /s/ HTTP/1.1\r\nHost: h\r\n\r\n')), { id: '', target: '/' })
  assert.equal(splitSourceTarget(parse('GET /s HTTP/1.1\r\nHost: h\r\n\r\n')), null)
  assert.equal(splitSourceTarget(parse('GET /sx/abcd1234 HTTP/1.1\r\nHost: h\r\n\r\n')), null)
  const old = parse('POST /s/abcd1234/x HTTP/1.0\r\nContent-Length: 1\r\n\r\n')
  assert.equal(Buffer.from(buildForwardHead(old, '/x')).toString('latin1'),
    'POST /x HTTP/1.0\r\nHost: 127.0.0.1:8091\r\nContent-Length: 1\r\nConnection: close\r\n\r\n', 'the version is kept')
  const te = parse('PUT /s/abcd1234/x HTTP/1.1\r\nHost: h\r\nTransfer-Encoding: chunked\r\nConnection: Transfer-Encoding\r\n\r\n')
  assert.match(Buffer.from(buildForwardHead(te, '/x')).toString('latin1'), /\r\nTransfer-Encoding: chunked\r\n/, 'framing never dropped through Connection')
})

test('forwarded head: the page\'s profile headers are dropped, the core\'s own added', () => {
  const r = parse('GET /s/abcd1234/api/library HTTP/1.1\r\nHost: h\r\nX-MPfy-Profile: ' + 'a'.repeat(32) + '\r\n' +
    'x-mpfy-profile-proof: ' + 'b'.repeat(192) + '\r\nConnection: X-MPfy-Profile\r\nX-Other: yes\r\n\r\n')
  assert.equal(Buffer.from(buildForwardHead(r, '/api/library')).toString('latin1'),
    'GET /api/library HTTP/1.1\r\nHost: 127.0.0.1:8091\r\nX-Other: yes\r\nConnection: close\r\n\r\n')
  assert.equal(Buffer.from(buildForwardHead(r, '/api/library', { 'X-MPfy-Profile': 'c'.repeat(32), 'X-MPfy-Profile-Proof': 'd'.repeat(192) })).toString('latin1'),
    'GET /api/library HTTP/1.1\r\nHost: 127.0.0.1:8091\r\nX-Other: yes\r\n' +
    'X-MPfy-Profile: ' + 'c'.repeat(32) + '\r\nX-MPfy-Profile-Proof: ' + 'd'.repeat(192) + '\r\nConnection: close\r\n\r\n',
    'the core\'s own pass even when the page names them in Connection')
})

test('response head and ETag comparison', () => {
  assert.equal(Buffer.from(responseHead(404, { 'Content-Length': 2, Skip: undefined })).toString(), 'HTTP/1.1 404 Not Found\r\nContent-Length: 2\r\n\r\n')
  assert.equal(etagMatches('W/"a-b"', 'W/"a-b"'), true)
  assert.equal(etagMatches('"x", W/"a-b"', 'W/"a-b"'), true)
  assert.equal(etagMatches('"a-b"', 'W/"a-b"'), true, 'weak comparison')
  assert.equal(etagMatches('*', 'W/"a-b"'), true)
  assert.equal(etagMatches('W/"a-c"', 'W/"a-b"'), false)
  assert.equal(etagMatches(undefined, 'W/"a-b"'), false)
})

test('throughput meter: busy time only, the first chunk of a flow marks its start, window, stalls, reset', () => {
  let now = 1000
  const m = new ThroughputMeter({ now: () => now })
  assert.equal(m.kbps(), null)
  const f = m.flow()
  // 1 Mbit/s: 125 KB per second in 10 chunks of 12.5 KB, for 5 s.
  f.data(12500) // the first chunk of a flow: marks the time only
  for (let i = 0; i < 50; i++) {
    now += 100
    f.data(12500)
  }
  assert.equal(m.kbps(), 1000)
  // A stall longer than 1.5 s is not counted as streaming time.
  now += 60000
  f.data(12500)
  for (let i = 0; i < 10; i++) {
    now += 100
    f.data(12500)
  }
  assert.equal(m.kbps(), 1000, 'the stall does not lower the rate')
  // Only the last 20 s of busy time count: 25 s at 4 Mbit/s hide the 1 Mbit/s.
  for (let i = 0; i < 250; i++) {
    now += 100
    f.data(50000)
  }
  assert.equal(m.kbps(), 4000)
  m.reset()
  assert.equal(m.kbps(), null)
  // After a reset the next chunk only marks a start, even in the middle of a flow.
  now += 100
  f.data(1000)
  now += 5
  f.data(1000)
  assert.equal(m.kbps(), null, 'a small burst says nothing yet')
  // Old samples expire after 10 minutes.
  for (let i = 0; i < 20; i++) {
    now += 100
    f.data(12500)
  }
  assert.equal(typeof m.kbps(), 'number')
  now += 11 * 60 * 1000
  assert.equal(m.kbps(), null)
  f.end()
  f.data(99999)
  assert.equal(m.kbps(), null, 'an ended flow counts nothing')
})

test('throughput meter: what the local reader holds back is not the link; flows share one timeline; the time between responses is not streaming', async () => {
  let now = 0
  const m = new ThroughputMeter({ now: () => now })
  const f = m.flow()
  f.data(16384)
  for (let i = 0; i < 100; i++) {
    now += 10
    f.data(16384)
  }
  assert.equal(m.kbps(), 13107)
  // A player whose buffer is full reads 33 KB a second (264 kbps): each time it
  // reads, what waited in the local buffers comes out at once, then it is full again.
  for (let i = 0; i < 40; i++) {
    f.pause()
    now += 1000
    f.resume()
    f.data(16500)
    f.data(16500)
  }
  f.pause()
  assert.equal(m.kbps(), 13107, 'the reader\'s pace is not the link\'s')
  // Let go for good: the rest of the buffer is skipped, then the link counts again
  // (its first chunk, a round trip after the resume, only marks the start).
  f.resume()
  f.data(16384)
  await Promise.resolve()
  now += 300
  f.data(32768)
  for (let i = 0; i < 100; i++) {
    now += 10
    f.data(32768)
  }
  // 2 s of busy time: 1 s at 13 107 kbps and 1 s at 26 214 kbps.
  assert.equal(m.kbps(), 19661)
  f.end()

  // Two flows of 1 Mbit/s each at the same time: the link carried 2 Mbit/s.
  const m2 = new ThroughputMeter({ now: () => now })
  const a = m2.flow()
  const b = m2.flow()
  a.data(12500)
  now += 50
  b.data(12500)
  for (let i = 0; i < 40; i++) {
    now += 50
    a.data(12500)
    now += 50
    b.data(12500)
  }
  const both = m2.kbps()
  assert.ok(both >= 1950 && both <= 2000, 'one timeline for both flows: ' + both)
  a.end()
  b.end()

  // Short responses one after the other: the round trips between them are not
  // streaming time, only the time their bodies took.
  const m3 = new ThroughputMeter({ now: () => now })
  for (let i = 0; i < 50; i++) {
    const r = m3.flow()
    r.data(6000)
    now += 10
    r.data(6000)
    r.end()
    now += 200
  }
  assert.equal(m3.kbps(), 4800)
})

// A local socket for pipeForward: write() returns false once `room` bytes are
// used; read(n) is the client taking n bytes, with 'drain' when it was full.
class FakeSocket extends EventEmitter {
  constructor () {
    super()
    this.room = Infinity
    this.received = 0
    this.destroyed = false
  }

  write (chunk) {
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
  destroy () {
    if (this.destroyed) return
    this.destroyed = true
    this.emit('close')
  }
}

test('forwarder and meter: a stream the player holds back measures the link, not the playback pace', async () => {
  let now = 0
  const meter = new ThroughputMeter({ now: () => now })
  const socket = new FakeSocket()
  // The source's side: what the test pushes is what arrives from the network.
  const stream = new Duplex({ write (data, cb) { cb(null) } })
  pipeForward({ socket, stream, head: B('GET /api/stream/x HTTP/1.1\r\nHost: 127.0.0.1:8091\r\n\r\n'), rest: B(''), req: { body: 'none' }, flow: meter.flow() })
  const tick = () => new Promise((resolve) => setImmediate(resolve))
  const chunk = Buffer.alloc(16384)

  // The link delivers 16 KB every 10 ms (13 Mbit/s) to a reader that keeps up.
  for (let i = 0; i < 101; i++) {
    now += 10
    stream.push(chunk)
    await tick()
  }
  assert.equal(meter.kbps(), 13107)

  // The player's buffer is full: the socket is too. The source still sends its
  // window (1 MB), which waits in the stream; then the player reads 33 KB a second
  // (264 kbps) and each read lets the waiting bytes out at memory speed.
  socket.room = 0
  for (let i = 0; i < 64; i++) {
    now += 10
    stream.push(chunk)
    await tick()
  }
  for (let i = 0; i < 25; i++) {
    now += 1000
    socket.read(33000)
    await tick()
  }
  assert.ok(socket.received > 101 * 16384 + 40 * 16384, 'the reader got the waiting bytes: ' + socket.received)
  assert.equal(meter.kbps(), 13107, 'the playback pace is not the link speed')

  // The reader catches up: the rest of the buffer is skipped, and the link counts
  // again from its next chunk (26 Mbit/s now).
  socket.read(Infinity)
  await tick()
  now += 300
  for (let i = 0; i < 101; i++) {
    now += 10
    stream.push(Buffer.alloc(32768))
    await tick()
  }
  // 2010 ms of busy time: 1010 ms at 13 107 kbps and 1000 ms at 26 214 kbps.
  assert.equal(meter.kbps(), 19628)
  assert.equal(socket.received, 165 * 16384 + 101 * 32768, 'every byte reached the reader')
  stream.push(null)
  await tick()
  socket.destroy()
})

test('state normalization: ids from keys, one principal, bad entries dropped, bad seed refused', () => {
  const seed = 'ab'.repeat(32)
  const k1 = '11'.repeat(32)
  const k2 = '22'.repeat(32)
  const r = normalizeState({
    clientSeed: seed.toUpperCase(),
    sources: [
      { id: 'wrong', name: '  Casa\u0007 ', serverPublicKey: k1.toUpperCase(), principal: true, addedAt: 5 },
      { id: k2.slice(0, 8), name: 'B', serverPublicKey: k2, principal: true, addedAt: 6 },
      { id: 'x', name: 'dup', serverPublicKey: k1, principal: false, addedAt: 7 },
      { name: 'no key' },
      null
    ]
  })
  assert.equal(r.changed, true)
  assert.equal(r.state.clientSeed, seed)
  assert.deepEqual(r.state.sources, [
    { id: '11111111', name: 'Casa', serverPublicKey: k1, principal: true, addedAt: 5, role: null, named: null, profiles: null, social: null, card: null },
    { id: '22222222', name: 'B', serverPublicKey: k2, principal: false, addedAt: 6, role: null, named: null, profiles: null, social: null, card: null }
  ])
  const none = normalizeState({ clientSeed: seed, sources: [{ id: '22222222', name: 'B', serverPublicKey: k2, principal: false, addedAt: 6 }] })
  assert.equal(none.state.sources[0].principal, true, 'the first becomes principal')
  const clean = normalizeState({ clientSeed: seed, profile: null, recovery: null, recoveryDeletes: [], social: defaultSocial(), sources: [] })
  assert.equal(clean.changed, false)
  assert.equal(normalizeState({ clientSeed: seed, profile: null, recovery: null, recoveryDeletes: [], sources: [] }).changed, true, 'a state from before the social part is written again with it')
  assert.equal(normalizeState({ clientSeed: seed, sources: [] }).changed, true, 'a state from before profiles is written again with them')
  assert.equal(normalizeState({ clientSeed: 'xyz', sources: [] }), null)
  assert.equal(normalizeState([]), null)
  assert.equal(cleanName('a'.repeat(70)).length, 60)
  assert.equal(cleanName(' a \n b '), 'a b')
  assert.equal(cleanName(5), '')
})

test('link errors in words, never codes', () => {
  assert.equal(linkErrorWords(null), null)
  assert.equal(linkErrorWords('PEER_NOT_FOUND'), 'spenta o senza rete')
  assert.equal(linkErrorWords('CONNECTION_CLOSED'), 'collegamento interrotto')
  assert.equal(linkErrorWords('HOLEPUNCH_ABORTED'), 'collegamento non riuscito')
})
