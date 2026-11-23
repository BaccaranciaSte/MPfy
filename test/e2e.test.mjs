// End to end over the REAL public HyperDHT: a source on random ports with a temp
// data dir; the permanent pairing code read locally (GET /api/admin/code), the
// owner window opened locally; two devices pair with it; a link (MPfyLink)
// carries the API, with the profile headers of the person, both through a local
// raw proxy and through link.request(); the first device's profile claims the
// source; then a dropped link comes back, and an unpaired key is refused by the
// firewall. Needs Internet (UDP) access.

import test from 'node:test'
import assert from 'node:assert/strict'
import DHT from 'hyperdht'
import { createMPfy } from '../server/app.mjs'
import { MPfyLink, pair, createDht, generateKeyPair } from '../transport/client.js'
import { makeWav, tmpDir, rmDir, request, json, makeProfile, proofHeaders } from './helpers.mjs'

test('e2e: permanent code, then health, upload, library, Range and admin over the public HyperDHT; firewall refuses strangers', { timeout: 150000 }, async (t) => {
  const started = Date.now()
  const mark = (what) => t.diagnostic(((Date.now() - started) / 1000).toFixed(1) + ' s ' + what)

  const dataDir = tmpDir('mpfy-e2e-data-')
  let app = null
  let link = null
  let dht = null
  let intruder = null
  t.after(async () => {
    if (intruder) intruder.destroy()
    if (link) await link.close()
    if (dht) await dht.destroy()
    if (app) await app.close()
    rmDir(dataDir)
  })

  app = await createMPfy({ dataDir, port: 0, adminPort: 0, p2p: true, waitForDht: true, debounceMs: 20, ffmpeg: null, name: 'Fonte e2e' })
  mark('source listening on the DHT (main and pairing keys)')

  const { code } = json(await request(app.ports.http, 'GET', '/api/admin/code'))
  assert.match(code, /^MPFY(-[0-9A-HJKMNP-TV-Z]{4}){8}$/)
  const window = json(await request(app.ports.http, 'POST', '/api/admin/claim', { body: { minutes: 10 } }))
  assert.ok(window.claimUntil > Date.now() && window.ownerProfileId === null, 'the owner window is open')

  dht = createDht()
  const kp = generateKeyPair()
  const res = await pair(code, { keyPair: kp, name: 'PC di prova', dht, timeout: 60000 })
  mark('paired with the permanent code')
  assert.deepEqual(res, { serverPublicKey: app.serverPublicKey, name: 'Fonte e2e' })
  assert.ok(app.clients.has(kp.publicKey), 'device admitted in clients.json')
  assert.equal(app.clients.list()[0].name, 'PC di prova')

  // The same code again, for another device, typed loosely.
  const kp2 = generateKeyPair()
  const res2 = await pair(code.toLowerCase().replace(/-/g, ' '), { keyPair: kp2, name: 'Secondo', dht, timeout: 60000 })
  mark('second device paired with the same code')
  assert.equal(res2.serverPublicKey, app.serverPublicKey)
  assert.equal(app.clients.list().length, 2)

  // The link, with a local raw proxy on a random port.
  const statuses = []
  link = new MPfyLink({ serverPublicKey: res.serverPublicKey, keyPair: kp, dht })
  link.on('status', (s) => statuses.push(s))
  const { port } = await link.listen()
  link.start()
  assert.equal(await link.waitConnected(45000), true)
  mark('link up')
  const person = makeProfile()
  const headers = proofHeaders(person, kp.publicKey, app.serverPublicKey)

  const health = await request(port, 'GET', '/api/health', { timeout: 45000 })
  assert.equal(health.status, 200)
  const h = json(health)
  assert.equal(h.ok, true)
  assert.equal(h.name, 'Fonte e2e')
  assert.equal(h.ffmpeg, false)
  assert.ok(statuses.some((s) => s.connected), 'a connected status event was emitted')

  // Upload bigger than the flow-control window, so credit has to flow back.
  const wav = makeWav({ seconds: 100, sampleRate: 8000, freq: 349 }) // about 1.6 MB
  const guest = await request(port, 'PUT', '/api/upload/x.wav', { body: Buffer.from('x'), timeout: 45000 })
  assert.equal(json(guest).code, 'no_profile', 'a device without a profile is a guest')
  const up = await request(port, 'PUT', '/api/upload/' + encodeURIComponent('Prova P2P.wav'), { body: wav, headers, timeout: 60000 })
  mark('upload through the link')
  assert.equal(up.status, 200)
  const { track, duplicate, outcome: upOutcome } = json(up)
  assert.equal(duplicate, false)
  assert.equal(upOutcome, 'added')
  assert.equal(track.mine, true)
  assert.equal(track.title, 'Prova P2P')
  assert.equal(track.size, wav.length)

  const lib = await link.request('GET', '/api/library', { timeout: 30000, headers })
  assert.equal(lib.status, 200)
  const library = JSON.parse(Buffer.from(lib.body).toString())
  assert.deepEqual(library.tracks.map((x) => x.id), [track.id])
  assert.deepEqual(library.you, { profileId: person.id, role: 'owner' }, 'the first profile in the window claimed the source')

  const start = 123457
  const end = 1300000
  const part = await request(port, 'GET', '/api/stream/' + track.id + '?q=normal', { headers: { ...headers, range: 'bytes=' + start + '-' + end } })
  mark('range through the link')
  assert.equal(part.status, 206)
  assert.equal(part.headers['x-mpfy-quality'], 'max', 'no ffmpeg: the original')
  assert.equal(part.headers['content-range'], 'bytes ' + start + '-' + end + '/' + wav.length)
  assert.ok(part.body.equals(wav.subarray(start, end + 1)), 'Range bytes identical')

  // The source knows who is asking.
  const clients = JSON.parse(Buffer.from((await link.request('GET', '/api/admin/clients', { timeout: 30000, headers })).body).toString()).clients
  assert.deepEqual(clients.map((c) => [c.name, c.connected, c.you, c.profileId]), [['PC di prova', true, true, person.id], ['Secondo', false, false, null]])
  const { rttMs } = link.status
  assert.ok(rttMs === null || (rttMs > 0 && rttMs < 10000), 'rttMs: ' + rttMs)
  mark('admin through the link, rtt ' + rttMs + ' ms')

  // The link drops (network change, tunnel): the next request brings it back.
  const dialsBefore = link.stats.dials
  link._conn.destroy()
  while (link.status.connected) await new Promise((resolve) => setTimeout(resolve, 20))
  const again = await request(port, 'GET', '/api/health', { timeout: 45000 })
  mark('reconnected after a dropped link')
  assert.equal(again.status, 200)
  assert.ok(link.stats.dials > dialsBefore, 'a new connection was dialled')
  assert.ok(statuses.some((s) => !s.connected), 'a disconnected status event was emitted')

  // A key that never paired: the firewall must refuse it.
  const rejectedBefore = app.transport.stats.rejected
  intruder = dht.connect(Buffer.from(app.serverPublicKey, 'hex'), { keyPair: DHT.keyPair() })
  const outcome = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 30000)
    intruder.on('open', () => { clearTimeout(timer); resolve('open') })
    intruder.on('error', (err) => { clearTimeout(timer); resolve('error ' + (err.code || err.message)) })
    intruder.on('close', () => { clearTimeout(timer); resolve('closed') })
  })
  mark('stranger: ' + outcome + ', firewall rejections ' + (app.transport.stats.rejected - rejectedBefore))
  assert.notEqual(outcome, 'open', 'an unpaired key got through')
  assert.ok(app.transport.stats.rejected > rejectedBefore, 'the firewall saw and refused the stranger')
})
