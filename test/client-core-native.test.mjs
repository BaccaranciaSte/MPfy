// What the app's own code (not the page) asks through the client core: the heart
// of the media notification and of the car, the covers that Android Auto, the
// lock screen and Bluetooth read, and the car playing with the page closed. The
// app sends them as its HttpURLConnection does: the token header, no Origin, no
// cookie, a PUT with an empty body, its own connection each. Real sources
// (server/app.mjs) on a local HyperDHT testnet.

import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import createTestnet from 'hyperdht/testnet.js'
import { createMPfy } from '../server/app.mjs'
import { createClientCore } from '../client-core/index.js'
import { parseResponse } from '../transport/client.js'
import { tmpDir, request, json, waitFor, cleanup, fakeFfmpeg, fakePng, makeMp3 } from './helpers.mjs'

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web')
const UA = 'Dalvik/2.1.0 (Linux; U; Android 10; Mi A2 Lite Build/QKQ1.191002.002)'

let testnet = null
const nodes = []

before(async () => {
  testnet = await createTestnet(3)
})

after(async () => {
  await Promise.all(nodes.map((n) => n.destroy()))
  await testnet.destroy()
})

function node () {
  const n = testnet.createNode()
  nodes.push(n)
  return n
}

async function source (t, { name, claim = false, ffmpeg = null }) {
  const c = cleanup(t)
  const app = await createMPfy({
    dataDir: c.dir(tmpDir('mpfy-ccn-src-')), port: 0, adminPort: 0, p2p: true, waitForDht: true, dht: node(), ffmpeg, fpcalc: null, sevenZip: null, debounceMs: 10, name
  })
  c.close(app)
  if (claim) app.people.openClaim(30)
  await app.jobsStarted
  return { app, id: app.serverPublicKey.slice(0, 8) }
}

// A core as the app runs it: with its token.
async function core (t) {
  const c = cleanup(t)
  const token = crypto.randomBytes(32).toString('hex')
  const events = []
  const statePath = path.join(c.dir(tmpDir('mpfy-ccn-core-')), 'state.json')
  const instance = createClientCore({ statePath, webRoot: WEB, port: 0, deviceName: 'Mi A2 Lite', token, onEvent: (e) => events.push(e), dht: node() })
  const { port } = await instance.start()
  const h = {
    port,
    token,
    events,
    close: () => instance.stop(),
    // What the page sends: the token too (its cookie), and the JSON helpers.
    call: (method, p, body = null, timeout = 90000) => request(port, method, p, { headers: { 'x-mpfy-token': token }, body, timeout }),
    sources: () => events.filter((e) => e.type === 'sources').pop().sources
  }
  c.close(h)
  return h
}

async function addSource (h, src) {
  const res = await h.call('POST', '/local/sources', { code: src.app.code })
  assert.equal(res.status, 201, res.body.toString())
  const entry = json(res).source
  await waitFor(() => h.sources().find((s) => s.id === entry.id)?.connected, { timeout: 30000, what: 'the link to ' + src.id })
  return entry
}

/**
 * One request as the app sends it, on a connection of its own. framing: 'length'
 * (Content-Length: 0), 'chunked' (an empty chunked body) or 'none' (no body
 * field at all). A gzip answer is unpacked, as HttpURLConnection does.
 */
function nativeRequest (port, method, target, { token, framing = 'none', headers = {} }) {
  let head = method + ' ' + target + ' HTTP/1.1\r\n'
  if (token !== null) head += 'X-MPfy-Token: ' + token + '\r\n'
  if (framing === 'length') head += 'Content-Length: 0\r\n'
  if (framing === 'chunked') head += 'Transfer-Encoding: chunked\r\n'
  for (const name of Object.keys(headers)) head += name + ': ' + headers[name] + '\r\n'
  head += 'Host: 127.0.0.1:' + port + '\r\nConnection: Keep-Alive\r\nAccept-Encoding: gzip\r\nUser-Agent: ' + UA + '\r\n\r\n'
  if (framing === 'chunked') head += '0\r\n\r\n'
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1')
    const chunks = []
    const timer = setTimeout(() => {
      sock.destroy()
      reject(new Error('no answer to ' + method + ' ' + target))
    }, 60000)
    sock.on('data', (c) => chunks.push(c))
    sock.on('error', () => {})
    sock.on('close', () => {
      clearTimeout(timer)
      try {
        const r = parseResponse(Buffer.concat(chunks))
        let body = Buffer.from(r.body)
        if (r.headers['content-encoding'] === 'gzip') body = zlib.gunzipSync(body)
        resolve({ status: r.status, headers: r.headers, body })
      } catch (err) {
        reject(err)
      }
    })
    sock.on('connect', () => sock.write(head))
  })
}

test('the heart from the notification and the car: a PUT on the principal the sources event names, a DELETE for each liked id, with the token alone; it lands in this person\'s likes; refused without the token; the next one follows the principal', { timeout: 180000 }, async (t) => {
  const s = await source(t, { name: 'Mi A2', claim: true })
  const s2 = await source(t, { name: 'PC' })
  const c = await core(t)
  const made = await c.call('POST', '/local/profile', { name: 'Bacca' })
  assert.equal(made.status, 201, made.body.toString())
  const profileId = json(made).profile.id
  await addSource(c, s)
  await addSource(c, s2)
  const principal = () => c.sources().filter((x) => x.principal).map((x) => [x.id, x.connected])
  assert.deepEqual(principal(), [[s.id, true]], 'the first source added, its link up')

  const up = await c.call('PUT', '/s/' + s.id + '/api/upload/' + encodeURIComponent('Blue Regret.mp3'), makeMp3({ title: 'Blue Regret', artist: 'NEA', frames: 60 }))
  assert.equal(up.status, 200, up.body.toString())
  const group = json(up).track.id
  const member = crypto.randomBytes(12).toString('hex') // the same song on another source, liked there too
  const likes = async (src) => {
    const lib = json(await c.call('GET', '/s/' + src.id + '/api/library'))
    return { you: lib.you, ids: lib.likes.map((l) => l.id) }
  }
  const heart = (src, method, id, opts = {}) => nativeRequest(c.port, method, '/s/' + src.id + '/api/likes/' + id, { token: c.token, ...opts })

  const refused = await heart(s, 'PUT', group, { token: null, framing: 'length' })
  assert.equal(refused.status, 403, 'no token, no request')
  assert.deepEqual((await likes(s)).ids, [])

  // Whatever framing the app's HTTP client gives an empty PUT, it reaches the source.
  for (const framing of ['length', 'none', 'chunked']) {
    const r = await heart(s, 'PUT', group, { framing })
    assert.equal(r.status, 200, framing + ': ' + r.body)
    assert.deepEqual(JSON.parse(r.body).likes.map((l) => l.id), [group], framing)
  }
  assert.deepEqual(await likes(s), { you: { profileId, role: 'owner' }, ids: [group] }, 'in this person\'s own likes')
  assert.equal((await heart(s, 'PUT', member, { framing: 'length' })).status, 200)
  assert.deepEqual((await likes(s)).ids, [member, group])

  // Unlike: one DELETE per liked id, every answer 2xx.
  for (const id of [group, member]) {
    const r = await heart(s, 'DELETE', id)
    assert.equal(r.status, 200, r.body.toString())
  }
  assert.deepEqual((await likes(s)).ids, [])
  assert.deepEqual((await likes(s2)).ids, [], 'nothing on the other source')

  // The principal moves: the next sources event says so, and the heart goes there.
  const moved = await c.call('PATCH', '/local/sources/' + s2.id, { principal: true })
  assert.equal(moved.status, 200, moved.body.toString())
  assert.deepEqual(principal(), [[s2.id, true]])
  assert.equal((await heart(s2, 'PUT', group, { framing: 'length' })).status, 200)
  assert.deepEqual(await likes(s2), { you: { profileId, role: 'member' }, ids: [group] })
  assert.deepEqual((await likes(s)).ids, [])
})

test('covers for the car, the lock screen and Bluetooth: the original with its own ETag until the sized one exists, then the sized one under "<coverId>.<size>", bytes as on the source; the car plays a version with the page closed', { timeout: 180000 }, async (t) => {
  const work = cleanup(t).dir(tmpDir('mpfy-ccn-ff-'))
  // Slow covers: the first request comes before the sized copies exist.
  const ff = fakeFfmpeg(work, { delayMs: 4000 })
  const s = await source(t, { name: 'Mi A2', claim: true, ffmpeg: ff.command })
  const c = await core(t)
  assert.equal((await c.call('POST', '/local/profile', { name: 'Bacca' })).status, 201)
  await addSource(c, s)

  const png = fakePng(7)
  const mp3 = makeMp3({ title: 'Blue Regret', artist: 'NEA', album: 'Blue Regret', cover: png, frames: 80 })
  const up = await c.call('PUT', '/s/' + s.id + '/api/upload/' + encodeURIComponent('Blue Regret.mp3'), mp3)
  assert.equal(up.status, 200, up.body.toString())
  const track = json(up).track
  const coverId = track.coverId
  assert.match(coverId, /^[0-9a-f]{24}$/)
  const cover = (size) => nativeRequest(c.port, 'GET', '/s/' + s.id + '/api/cover/' + coverId + '?size=' + size, { token: c.token })

  const early = await cover('small')
  assert.equal(early.status, 200)
  assert.equal(early.headers.etag, '"' + coverId + '"', 'the original: an answer the provider must not keep')
  assert.equal(early.headers['content-type'], 'image/png')
  assert.ok(early.body.equals(png))

  ff.control({ delayMs: 0 })
  for (const size of ['small', 'large']) {
    const sized = await waitFor(async () => {
      const r = await cover(size)
      return r.headers.etag === '"' + coverId + '.' + size + '"' ? r : null
    }, { timeout: 60000, interval: 200, what: 'the ' + size + ' cover' })
    assert.equal(sized.status, 200)
    assert.equal(sized.headers['content-type'], 'image/jpeg')
    assert.ok(sized.body.equals(fs.readFileSync(s.app.library.sizedCoverPath(coverId, size))), size + ': the bytes on the source')
    assert.deepEqual([...sized.body.subarray(0, 3)], [0xff, 0xd8, 0xff], 'JPEG magic')
  }
  assert.equal((await nativeRequest(c.port, 'GET', '/s/' + s.id + '/api/cover/' + coverId + '?size=small', { token: null })).status, 403)

  // A car item: a version from the snapshot, as the player asks for it.
  const st = await nativeRequest(c.port, 'GET', '/s/' + s.id + '/api/stream/' + track.id + '?q=max&f=' + track.fileHash, { token: c.token, headers: { Range: 'bytes=100-' } })
  assert.equal(st.status, 206, st.body.toString().slice(0, 200))
  assert.equal(st.headers['content-range'], 'bytes 100-' + (mp3.length - 1) + '/' + mp3.length)
  assert.ok(st.body.equals(mp3.subarray(100)), 'the file itself')
})
