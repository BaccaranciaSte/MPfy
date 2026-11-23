// Resumable uploads: chunks written at the stored offset, a cut request leaving
// what reached the disk, one writer per session, a restart truncating bytes past
// the offset, resuming by name, size, date and head hash; the limits (413, 415,
// 429 with idle sessions giving their slot, 507); the last chunk's pipeline
// running on after its request is gone; results kept an hour, sessions expiring;
// and the disk rule with its reservations and floor.

import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { createMPfy } from '../server/app.mjs'
import { Disk } from '../server/disk.mjs'
import { tmpDir, cleanup, json, makeWav, makeProfile, device, testWhoIs, fakeTool, waitFor, proofHeaders } from './helpers.mjs'

const body = (r) => json(r)
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex')
const MB = 1024 * 1024

async function start (t, opts = {}) {
  const c = cleanup(t)
  const dir = opts.dir || c.dir(tmpDir())
  const app = c.close(await createMPfy({
    dataDir: dir, port: 0, adminPort: 0, p2p: false, debounceMs: 10, ffmpeg: null, fpcalc: null, sevenZip: null, whoIs: testWhoIs, ...opts
  }))
  if (opts.restart) return { app, dir }
  app.people.openClaim(30)
  const owner = device(app, { profile: makeProfile(), name: 'Bacca' })
  assert.equal(body(await owner.call('GET', '/api/profile')).role, 'owner')
  return { app, dir, owner }
}

const newSession = (dev, buf, name = 'lungo.wav', extra = {}) => dev.call('POST', '/api/uploads', {
  body: { name, size: buf.length, lastModified: 1763380000000, headHash: sha256(buf.subarray(0, 65536)), ...extra }
})
const put = (dev, id, offset, buf) => dev.call('PUT', '/api/uploads/' + id + '?offset=' + offset, { body: buf })

// A chunk PUT that sends only `send` bytes of a declared `length`, then waits
// for `cut()` to destroy it.
function partialPut (app, dev, id, offset, length, send, urlPath = '/api/uploads/' + id + '?offset=' + offset) {
  const headers = { 'x-test-client': dev.key, ...proofHeaders(dev.profile, dev.key, app.serverPublicKey), 'content-length': length }
  const req = http.request({ host: '127.0.0.1', port: app.ports.http, method: 'PUT', path: urlPath, headers, localAddress: '127.0.0.2', agent: false })
  req.on('error', () => {})
  const answered = new Promise((resolve) => req.on('response', (res) => {
    const chunks = []
    res.on('data', (c) => chunks.push(c))
    res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }))
  }))
  req.write(send)
  return { cut: () => req.destroy(), answered, req }
}

test('sessions: chunks at the stored offset; a cut request leaves what reached the disk; wrong offset is 409 with the stored one; resume by name, size, date and head hash; the last chunk runs the pipeline', async (t) => {
  const { app, dir, owner } = await start(t)
  const wav = makeWav({ seconds: 20, sampleRate: 8000, freq: 450 }) // 320 KB
  let r = await newSession(owner, wav)
  assert.equal(r.status, 201)
  const s = body(r)
  assert.deepEqual(Object.keys(s).sort(), ['chunkBytes', 'expiresAt', 'id', 'offset', 'size'])
  assert.deepEqual([s.size, s.offset, s.chunkBytes], [wav.length, 0, 8388608])
  assert.match(s.id, /^[0-9a-f]{16}$/)
  assert.ok(s.expiresAt > Date.now() + 23 * 3600e3)

  r = await put(owner, s.id, 0, wav.subarray(0, 100000))
  assert.deepEqual(body(r), { offset: 100000 })
  // Cut midway: 30000 of the 100000 declared bytes arrive, then the link drops.
  const cut = partialPut(app, owner, s.id, 100000, 100000, wav.subarray(100000, 130000))
  await waitFor(async () => fs.statSync(path.join(dir, 'uploads', s.id + '.part')).size === 130000, { what: 'the bytes on disk' })
  cut.cut()
  await waitFor(async () => body(await owner.call('GET', '/api/uploads/' + s.id)).offset === 130000, { what: 'the offset of the bytes that reached the disk' })
  r = await put(owner, s.id, 100000, wav.subarray(100000, 200000))
  assert.equal(r.status, 409)
  assert.equal(body(r).code, 'offset_mismatch')
  assert.equal(body(r).offset, 130000, 'the answer carries the stored offset')
  assert.equal(body(r).done, false)
  // The same file again: the session is resumed, not made twice.
  r = await newSession(owner, wav)
  assert.equal(r.status, 200)
  assert.deepEqual(body(r).id, s.id)
  assert.equal(body(r).offset, 130000)
  assert.equal(body(await newSession(owner, wav, 'lungo.wav', { lastModified: 5 })).id === s.id, false, 'another date is another file')
  // The rest; the last chunk answers with the upload result.
  r = await put(owner, s.id, 130000, wav.subarray(130000))
  assert.equal(r.status, 200)
  const done = body(r)
  assert.equal(done.done, true)
  assert.equal(done.offset, wav.length)
  assert.equal(done.result.outcome, 'added')
  assert.equal(done.result.track.size, wav.length)
  assert.ok(fs.readFileSync(app.library.trackPath(app.library.getTrack(done.result.track.id))).equals(wav), 'the file is exactly the upload')
  assert.ok(!fs.existsSync(path.join(dir, 'uploads', s.id + '.part')))
  // Finished: GET keeps the result; a PUT at offset == size is 409 and runs nothing.
  r = await owner.call('GET', '/api/uploads/' + s.id)
  assert.equal(body(r).done, true)
  assert.equal(body(r).processing, false)
  assert.equal(body(r).result.outcome, 'added')
  r = await put(owner, s.id, wav.length, Buffer.alloc(0))
  assert.equal(r.status, 409)
  assert.equal(body(r).done, true)
  assert.equal(app.library.tracks.size, 1)
  // The 409 is the session's state as GET shows it, plus the code: no error for an upload that worked.
  assert.deepEqual(body(r), { ...body(await owner.call('GET', '/api/uploads/' + s.id)), code: 'offset_mismatch' })
  assert.equal(body(r).error, undefined)
  // One that failed keeps its own error object and code.
  const junk = Buffer.from('solo testo, nessun audio '.repeat(2000))
  const bad = body(await newSession(owner, junk, 'finto.wav'))
  r = await put(owner, bad.id, 0, junk)
  assert.equal(r.status, 415)
  assert.equal(body(r).code, 'not_audio')
  r = await put(owner, bad.id, 0, junk)
  assert.equal(r.status, 409)
  const state = body(await owner.call('GET', '/api/uploads/' + bad.id))
  assert.equal(state.error.code, 'not_audio')
  assert.deepEqual(body(r), { ...state, code: 'offset_mismatch' })
  // Kept 1 h, then gone.
  app.sessions.sweep(Date.now() + 59 * 60000)
  assert.equal((await owner.call('GET', '/api/uploads/' + s.id)).status, 200)
  app.sessions.sweep(Date.now() + 61 * 60000)
  r = await owner.call('GET', '/api/uploads/' + s.id)
  assert.equal(r.status, 404)
  assert.deepEqual(body(r), { error: 'Caricamento non trovato', code: 'session_gone' })
})

test('sessions: a second PUT while the first is open destroys it, no byte twice; a restart truncates bytes past the offset', async (t) => {
  const { app, dir, owner } = await start(t)
  const wav = makeWav({ seconds: 10, sampleRate: 8000, freq: 451 })
  const s = body(await newSession(owner, wav))
  const first = partialPut(app, owner, s.id, 0, 100000, wav.subarray(0, 40000))
  await waitFor(() => fs.statSync(path.join(dir, 'uploads', s.id + '.part')).size === 40000, { what: 'the first writer\'s bytes' })
  // The client gave up on the first request and asks again from where it began.
  let r = await put(owner, s.id, 0, wav.subarray(0, 100000))
  assert.equal(r.status, 409, 'the stored offset moved: the first request wrote 40000 bytes')
  assert.equal(body(r).offset, 40000)
  const lost = await Promise.race([first.answered, new Promise((resolve) => setTimeout(() => resolve('destroyed'), 300))])
  assert.equal(lost, 'destroyed', 'the first request got no answer: it was destroyed')
  r = await put(owner, s.id, 40000, wav.subarray(40000, 60000))
  assert.deepEqual(body(r), { offset: 60000 })

  // A crash after a write but before the record: bytes past the stored offset.
  await app.close()
  fs.appendFileSync(path.join(dir, 'uploads', s.id + '.part'), Buffer.alloc(wav.length - 60000 + 5000, 0x55)) // longer than the rest of the file
  const again = await start(t, { dir, restart: true })
  const dev = owner.on(again.app)
  assert.equal(body(await dev.call('GET', '/api/uploads/' + s.id)).offset, 60000)
  r = await put(dev, s.id, 60000, wav.subarray(60000))
  assert.equal(body(r).done, true)
  const track = again.app.library.getTrack(body(r).result.track.id)
  assert.ok(fs.readFileSync(again.app.library.trackPath(track)).equals(wav), 'no rubbish, no byte twice; the running hash was made again')
  assert.equal(track.id, crypto.createHash('sha256').update(wav).digest('hex').slice(0, 24))
})

test('sessions: the last chunk\'s request cut while the pipeline runs: GET shows processing, then done with the result', async (t) => {
  const work = cleanup(t).dir(tmpDir('mpfy-fp-'))
  const fpcalc = fakeTool(work, 'fpcalc', { delayMs: 1200 })
  const { app, owner } = await start(t, { fpcalc: fpcalc.command })
  const wav = makeWav({ seconds: 5, sampleRate: 8000, freq: 452 })
  const s = body(await newSession(owner, wav))
  assert.deepEqual(body(await put(owner, s.id, 0, wav.subarray(0, 50000))), { offset: 50000 })
  const last = partialPut(app, owner, s.id, 50000, wav.length - 50000, wav.subarray(50000))
  await waitFor(async () => body(await owner.call('GET', '/api/uploads/' + s.id)).processing === true, { what: 'processing' })
  last.cut()
  const mid = body(await owner.call('GET', '/api/uploads/' + s.id))
  assert.deepEqual([mid.processing, mid.done, mid.offset], [true, false, wav.length])
  assert.equal((await put(owner, s.id, wav.length, Buffer.alloc(0))).status, 409, 'never a second pipeline')
  const done = await waitFor(async () => {
    const v = body(await owner.call('GET', '/api/uploads/' + s.id))
    return v.done ? v : null
  }, { what: 'done', timeout: 15000 })
  assert.equal(done.processing, false)
  assert.equal(done.result.outcome, 'added')
  assert.equal(fpcalc.calls().filter((c) => c.key && !c.started).length, 1, 'the pipeline ran once')
  assert.equal(app.library.tracks.size, 1)

  // The last chunk's request still open: a PUT meanwhile is answered at once,
  // and the waiting request keeps its answer.
  const wav2 = makeWav({ seconds: 5, sampleRate: 8000, freq: 453 })
  const s2 = body(await newSession(owner, wav2))
  const lastPut = put(owner, s2.id, 0, wav2)
  await waitFor(async () => body(await owner.call('GET', '/api/uploads/' + s2.id)).processing === true, { what: 'processing' })
  const early = await put(owner, s2.id, wav2.length, Buffer.alloc(0))
  assert.equal(early.status, 409)
  assert.equal(body(early).processing, true, 'answered while the pipeline still runs')
  const answer = await lastPut
  assert.equal(answer.status, 200)
  assert.equal(body(answer).result.outcome, 'added')
})

test('sessions: limits 413, 415, 429 (an idle hour gives the slot; the owner outside the 16), other profiles 404, only the caller\'s listed, expiry, an archive session of WAV bytes is 415', async (t) => {
  const { app, dir, owner } = await start(t)
  const sara = device(app, { profile: makeProfile(), name: 'Sara' })
  const marco = device(app, { profile: makeProfile(), name: 'Marco' })
  const new1 = (dev, name, size = 1000) => dev.call('POST', '/api/uploads', { body: { name, size, lastModified: 1, headHash: sha256(name) } })

  let r = await new1(sara, 'enorme.flac', 629145601)
  assert.equal(r.status, 413)
  assert.deepEqual(body(r), { error: 'File troppo grande (massimo 600 MB)', code: 'too_large' })
  assert.equal((await new1(sara, 'album.zip', 629145601)).status, 201, 'an archive may be bigger')
  r = await new1(sara, 'album.rar', 4294967297)
  assert.deepEqual(body(r), { error: 'File troppo grande (massimo 4 GB)', code: 'too_large' })
  for (const name of ['album.7z', 'album.RAR']) {
    r = await new1(sara, name)
    assert.equal(r.status, 415, name)
    assert.deepEqual(body(r), { error: 'Formato non supportato', code: 'unsupported_archive' })
  }
  for (const b of [{ name: '', size: 1, lastModified: 1, headHash: 'a'.repeat(64) }, { name: 'x', size: 0, lastModified: 1, headHash: 'a'.repeat(64) }, { name: 'x', size: 1, lastModified: 1, headHash: 'zz' }]) {
    assert.equal((await sara.call('POST', '/api/uploads', { body: b })).status, 400)
  }

  // Sara has 1 (the zip); 3 more make 4, the 5th is refused.
  const ids = [body(await new1(sara, 'a.wav')).id, body(await new1(sara, 'b.wav')).id, body(await new1(sara, 'c.wav')).id]
  r = await new1(sara, 'd.wav')
  assert.equal(r.status, 429)
  assert.deepEqual(body(r), { error: 'Troppi caricamenti in corso', code: 'too_many_uploads' })
  // One idle for an hour gives its slot.
  app.sessions._s.get(ids[0]).rec.updatedAt -= 61 * 60000
  assert.equal((await new1(sara, 'd.wav')).status, 201)
  assert.equal((await sara.call('GET', '/api/uploads/' + ids[0])).status, 404, 'the idle one was cancelled')
  assert.ok(!fs.existsSync(path.join(dir, 'uploads', ids[0] + '.part')))

  // Only the caller's sessions, and nobody else's by id.
  const listed = body(await sara.call('GET', '/api/uploads')).sessions
  assert.equal(listed.length, 4)
  assert.deepEqual(Object.keys(listed[0]).sort(), ['id', 'lastModified', 'name', 'offset', 'size', 'updatedAt'])
  assert.deepEqual(body(await marco.call('GET', '/api/uploads')).sessions, [])
  for (const [method, b] of [['GET'], ['DELETE'], ['PUT', Buffer.from('x')]]) {
    r = await marco.call(method, '/api/uploads/' + ids[1] + (method === 'PUT' ? '?offset=0' : ''), { body: b || null })
    assert.equal(r.status, 404, method)
    assert.equal(body(r).code, 'session_gone')
  }

  // 16 for the members in all: Marco and two more fill it; the owner is outside.
  const others = [marco, device(app, { profile: makeProfile() }), device(app, { profile: makeProfile() })]
  for (const [i, d] of others.entries()) {
    for (let j = 0; j < 4; j++) assert.equal((await new1(d, 'm' + i + j + '.wav')).status, 201)
  }
  const fifth = device(app, { profile: makeProfile() })
  assert.equal((await new1(fifth, 'x.wav')).status, 429, 'the 17th member session')
  for (let j = 0; j < 4; j++) assert.equal((await new1(owner, 'o' + j + '.wav')).status, 201, 'the owner does not count in the 16')
  app.sessions._s.get(ids[1]).rec.updatedAt -= 61 * 60000
  assert.equal((await new1(fifth, 'x.wav')).status, 201, 'the oldest idle member session gave its slot')

  // DELETE cancels; 24 h without a chunk expire.
  const x = body(await new1(owner, 'p.wav'))
  assert.deepEqual(body(await owner.call('DELETE', '/api/uploads/' + body(await new1(owner, 'o0.wav')).id)), { ok: true })
  app.sessions.sweep(Date.now() + 24 * 3600e3 + 60000)
  assert.equal((await owner.call('GET', '/api/uploads/' + x.id)).status, 404)
  assert.deepEqual(fs.readdirSync(path.join(dir, 'uploads')), [])

  // An archive session must start with its own magic.
  const wav = makeWav({ freq: 460 })
  const z = body(await newSession(owner, wav, 'album.zip'))
  r = await put(owner, z.id, 0, wav)
  assert.equal(r.status, 415)
  assert.equal(body(r).code, 'unsupported_archive')
  assert.equal(body(await owner.call('GET', '/api/uploads/' + z.id)).error.code, 'unsupported_archive')
})

test('disk rule: a session reserves its remaining bytes; a single PUT refuses on Content-Length; the default floor is the larger of 2 GiB and 5%', async (t) => {
  let free = 20 * MB
  const statfs = async () => ({ bavail: free / 4096, bsize: 4096, blocks: (100 * MB) / 4096 })
  const { app, owner } = await start(t, { statfs, minFreeBytes: 4 * MB })
  const big = (name, size) => owner.call('POST', '/api/uploads', { body: { name, size, lastModified: 1, headHash: sha256(name) } })
  assert.equal((await big('uno.flac', 10 * MB)).status, 201)
  let r = await big('due.flac', 8 * MB)
  assert.equal(r.status, 507, 'fits alone (20 - 8 >= 4), not beside the first (20 - 10 - 8 < 4)')
  assert.deepEqual(body(r), { error: 'Spazio su disco esaurito sulla fonte', code: 'disk_full' })
  assert.equal((await big('tre.flac', 5 * MB)).status, 201)
  // Declares 2 MB and sends only its start: the answer comes before the body.
  const refused = partialPut(app, owner, null, 0, 2 * MB, Buffer.alloc(1000), '/api/upload/grande.wav')
  r = await refused.answered
  refused.cut()
  assert.equal(r.status, 507, '20 - 15 reserved - 2 < 4: refused on Content-Length')
  free = 40 * MB
  assert.equal((await owner.call('PUT', '/api/upload/w.wav', { body: makeWav({ freq: 470 }) })).status, 200)
  assert.equal(app.disk.reserved(), 15 * MB)

  const d = new Disk({ dataDir: '.', statfs: async () => ({ bavail: 1, bsize: 1, blocks: 100 * 1024 ** 3 }) })
  assert.equal((await d.state()).floor, 5 * 1024 ** 3, '5% of 100 GiB')
  const small = new Disk({ dataDir: '.', statfs: async () => ({ bavail: 1, bsize: 1, blocks: 10 * 1024 ** 3 }) })
  assert.equal((await small.state()).floor, 2 * 1024 ** 3, '2 GiB over 5% of 10 GiB')
})

test('sessions: a pipeline cut by a restart runs again at start, so a client polling it gets its answer', async (t) => {
  const { app, dir, owner } = await start(t)
  const wav = makeWav({ seconds: 4, sampleRate: 8000, freq: 455 })
  const s = body(await newSession(owner, wav))
  assert.deepEqual(body(await put(owner, s.id, 0, wav.subarray(0, 30000))), { offset: 30000 })
  await app.close()
  // Every byte reached the disk, the record says so, but the pipeline never ended.
  fs.writeFileSync(path.join(dir, 'uploads', s.id + '.part'), wav)
  const rec = JSON.parse(fs.readFileSync(path.join(dir, 'uploads', s.id + '.json'), 'utf8'))
  fs.writeFileSync(path.join(dir, 'uploads', s.id + '.json'), JSON.stringify({ ...rec, offset: wav.length }))
  const again = await start(t, { dir, restart: true })
  const dev = owner.on(again.app)
  const done = await waitFor(async () => {
    const v = body(await dev.call('GET', '/api/uploads/' + s.id))
    return v.done ? v : null
  }, { what: 'done after the restart' })
  assert.equal(done.result.outcome, 'added')
  assert.equal(done.result.track.id, crypto.createHash('sha256').update(wav).digest('hex').slice(0, 24), 'hashed again from the file')
})

test('disk rule: a single PUT reserves what it still has to send, so two at once never pass the floor together; the room is checked again while it streams', { timeout: 60000 }, async (t) => {
  let free = 20 * MB
  const statfs = async () => ({ bavail: free / 4096, bsize: 4096, blocks: (100 * MB) / 4096 })
  const { app, owner } = await start(t, { statfs, minFreeBytes: 4 * MB })
  const a = makeWav({ seconds: 625, sampleRate: 8000, freq: 480 }) // about 9.5 MB
  const b = makeWav({ seconds: 625, sampleRate: 8000, freq: 481 })
  const first = partialPut(app, owner, null, 0, a.length, a.subarray(0, MB), '/api/upload/a.wav')
  await waitFor(() => app.disk.reserved() > 0 && app.disk.reserved() <= a.length - MB, { what: 'the first upload under way' })
  // Alone it fits (20 - 9.5 >= 4); beside what the first still has to send it does not.
  const second = partialPut(app, owner, null, 0, b.length, b.subarray(0, 1000), '/api/upload/b.wav')
  const r = await second.answered
  second.cut()
  assert.equal(r.status, 507)
  assert.equal(body(r).code, 'disk_full')
  first.req.end(a.subarray(MB))
  const done = await first.answered
  assert.equal(done.status, 200)
  assert.equal(body(done).outcome, 'added')
  assert.equal(app.disk.reserved(), 0, 'released once received')

  // The disk fills up from elsewhere while a declared upload streams: refused at the next 8 MB.
  const third = partialPut(app, owner, null, 0, b.length, b.subarray(0, MB), '/api/upload/c.wav')
  await waitFor(() => app.disk.reserved() > 0 && app.disk.reserved() <= b.length - MB, { what: 'the third upload under way' })
  free = 5 * MB
  // The answer comes while the client still sends: on some systems the
  // connection is reset before the client reads it.
  const reset = new Promise((resolve) => third.req.on('error', (err) => resolve({ status: 0, code: err.code })))
  third.req.end(b.subarray(MB))
  const late = await Promise.race([third.answered, reset])
  assert.ok(late.status === 507 || late.code === 'ECONNRESET', 'refused: ' + JSON.stringify(late))
  await waitFor(() => app.disk.reserved() === 0, { what: 'the upload given up' })
  assert.equal(app.library.tracks.size, 1)
  assert.equal(app.disk.reserved(), 0)
  assert.deepEqual(fs.readdirSync(app.library.tmpDir).filter((f) => f.startsWith('up-')), [])
})
