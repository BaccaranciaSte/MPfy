// Upload, duplicate detection, streaming and library endpoints over plain HTTP
// (no P2P: p2p false), on random ports with a temp data dir.

import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import zlib from 'node:zlib'
import { createMPfy } from '../server/app.mjs'
import { makeWav, makeMp3, makeAdts, noise, fakePng, tmpDir, rmDir, request, json, shardPath, treeFiles } from './helpers.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const idOf = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 24)

async function start (t, opts = {}) {
  const dir = tmpDir()
  const web = tmpDir('mpfy-web-')
  fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><title>MPfy</title>')
  const app = await createMPfy({ dataDir: dir, webDir: web, port: 0, adminPort: 0, p2p: false, debounceMs: 20, ffmpeg: null, ...opts })
  t.after(async () => {
    await app.close()
    rmDir(dir)
    rmDir(web)
  })
  return { app, dir, port: app.ports.http }
}

const upload = (port, name, body, headers = {}) => request(port, 'PUT', '/api/upload/' + encodeURIComponent(name), { body, headers })

test('upload: new file, duplicate by content, different samples', async (t) => {
  const { app, dir, port } = await start(t)
  const a = makeWav({ freq: 440 })
  const b = makeWav({ freq: 440, phase: 1 }) // same length, different samples

  const r1 = await upload(port, 'Canzone del mare.wav', a)
  assert.equal(r1.status, 200)
  const j1 = json(r1)
  assert.equal(j1.duplicate, false)
  assert.equal(j1.track.id, idOf(a))
  assert.equal(j1.track.title, 'Canzone del mare', 'no tags: title from the file name')
  assert.equal(j1.track.artist, 'Artista sconosciuto')
  assert.equal(j1.track.album, 'Album sconosciuto')
  assert.equal(j1.track.albumArtist, 'Artista sconosciuto')
  assert.equal(j1.track.format, 'wav')
  assert.equal(j1.track.mime, 'audio/wav')
  assert.equal(j1.track.size, a.length)
  assert.equal(j1.track.duration, 1)
  assert.ok(fs.existsSync(shardPath(dir, 'library', j1.track.id + '.wav')))
  assert.deepEqual(fs.readFileSync(shardPath(dir, 'library', j1.track.id + '.wav')), a, 'stored exactly as uploaded')

  const r2 = await upload(port, 'altro nome.wav', a)
  const j2 = json(r2)
  assert.equal(r2.status, 200)
  assert.equal(j2.duplicate, true)
  assert.equal(j2.track.id, j1.track.id)
  assert.equal(j2.track.title, 'Canzone del mare', 'the existing track is returned')

  const r3 = await upload(port, 'b.wav', b)
  const j3 = json(r3)
  assert.equal(j3.duplicate, false)
  assert.notEqual(j3.track.id, j1.track.id)

  assert.equal(app.library.tracks.size, 2)
  assert.equal(treeFiles(dir, 'library').length, 2, 'the duplicate was not stored twice')
  assert.deepEqual(fs.readdirSync(path.join(dir, 'tmp')), [], 'no temp files left')
})

test('upload: the same new content twice at once gives one track and one duplicate', async (t) => {
  const { app, port } = await start(t)
  const a = makeWav({ freq: 523, seconds: 2 })
  const [r1, r2] = await Promise.all([upload(port, 'x.wav', a), upload(port, 'y.wav', a)])
  const dups = [json(r1).duplicate, json(r2).duplicate].sort()
  assert.deepEqual(dups, [false, true])
  assert.equal(app.library.tracks.size, 1)
})

test('upload: tags and embedded cover are extracted', async (t) => {
  const { port } = await start(t)
  const png = fakePng(7)
  const mp3 = makeMp3({ title: 'Stella', artist: 'Cielo', album: 'Notte', cover: png })
  const r = await upload(port, 'file.mp3', mp3)
  assert.equal(r.status, 200)
  const { track } = json(r)
  assert.equal(track.title, 'Stella')
  assert.equal(track.artist, 'Cielo')
  assert.equal(track.album, 'Notte')
  assert.equal(track.albumArtist, 'Cielo')
  assert.equal(track.format, 'mp3')
  assert.equal(track.mime, 'audio/mpeg')
  assert.equal(track.bitrate, 128000)
  assert.equal(track.coverId, idOf(png))

  const c = await request(port, 'GET', '/api/cover/' + track.coverId)
  assert.equal(c.status, 200)
  assert.equal(c.headers['content-type'], 'image/png')
  assert.match(c.headers['cache-control'], /immutable/)
  assert.deepEqual(c.body, png)
  const c304 = await request(port, 'GET', '/api/cover/' + track.coverId, { headers: { 'if-none-match': c.headers.etag } })
  assert.equal(c304.status, 304)
  const cPart = await request(port, 'GET', '/api/cover/' + track.coverId, { headers: { range: 'bytes=8-15' } })
  assert.equal(cPart.status, 206, 'Range on covers too')
  assert.equal(cPart.headers['content-range'], 'bytes 8-15/' + png.length)
  assert.deepEqual(cPart.body, png.subarray(8, 16))
})

test('upload: not audio is 415, whatever the extension; nothing is left behind', async (t) => {
  const { app, dir, port } = await start(t)
  const r = await upload(port, 'finto.mp3', Buffer.from('questo non e\' audio '.repeat(500)))
  assert.equal(r.status, 415)
  assert.match(json(r).error, /audio/)
  const png = await upload(port, 'immagine.flac', fakePng())
  assert.equal(png.status, 415)
  const empty = await upload(port, 'vuoto.wav', Buffer.alloc(0))
  assert.equal(empty.status, 400)
  assert.equal(app.library.tracks.size, 0)
  assert.deepEqual(fs.readdirSync(path.join(dir, 'tmp')), [])
  assert.deepEqual(treeFiles(dir, 'library'), [])
})

test('upload: a valid MPEG frame header in front of random bytes is not audio (415)', async (t) => {
  const { app, dir, port } = await start(t)
  // The parser resyncs across noise and counts spurious frame headers, so what it
  // makes of noise varies from sample to sample. Noise seeds 213 and 272 are ones
  // where it reports "mp3" 0.51 s and 0.93 s: they pass every other check (magic
  // bytes, parse, format, minimum duration) and only the frame chain refuses them
  // (found by a search over seeds 0-399). Two fresh random samples on top.
  const header = Buffer.from([0xff, 0xfb, 0x90, 0x64]) // a real MPEG-1 Layer III header
  const tagged = makeMp3({ frames: 1, title: 'Finto' }) // ID3 tag + one real frame
  const samples = [
    ['raw header + noise 213', Buffer.concat([header, noise(213, 200 * 1024)])],
    ['raw header + noise 272', Buffer.concat([header, noise(272, 200 * 1024)])],
    ['ID3 + one frame + noise 213', Buffer.concat([tagged, noise(213, 200 * 1024)])],
    ['ID3 + one frame + noise 272', Buffer.concat([tagged, noise(272, 200 * 1024)])],
    ['raw header + random', Buffer.concat([header, crypto.randomBytes(200 * 1024)])],
    ['ID3 + one frame + random', Buffer.concat([tagged, crypto.randomBytes(200 * 1024)])]
  ]
  for (const [what, body] of samples) {
    const r = await upload(port, 'rumore.mp3', body)
    assert.equal(r.status, 415, what)
  }
  // Real (short) streams still go through: 40 MP3 frames (about 1 s) and
  // 50 ADTS frames (about 1.2 s).
  const ok = await upload(port, 'vero.mp3', makeMp3({ frames: 40, title: 'Vero' }))
  assert.equal(ok.status, 200)
  assert.ok(json(ok).track.duration >= 1)
  const aac = await upload(port, 'vero.aac', makeAdts({ frames: 50 }))
  assert.equal(aac.status, 200, 'ADTS: ' + aac.body.toString())
  assert.equal(json(aac).track.format, 'aac')
  // Too short to be a song, even if well formed: 5 frames, about 0.13 s.
  const tiny = await upload(port, 'corto.mp3', makeMp3({ frames: 5 }))
  assert.equal(tiny.status, 415)
  assert.equal(app.library.tracks.size, 2)
  assert.deepEqual(fs.readdirSync(path.join(dir, 'tmp')), [])
})

test('upload: the new name in library/ is made durable (directory fsync) before the track enters the db', async (t) => {
  const { app, port } = await start(t)
  const wav = makeWav({ freq: 610 })
  const id = idOf(wav)
  const libDir = path.join(app.library.libraryDir, id.slice(0, 2))
  // fsyncDirSync opens the directory to fsync it (on Windows that open fails and is
  // ignored, the attempt is what counts here). Record each attempt on library/.
  const seen = []
  const original = fs.openSync
  t.mock.method(fs, 'openSync', function (p, ...rest) {
    if (p === libDir) {
      seen.push({
        fileInPlace: fs.existsSync(path.join(libDir, id + '.wav')),
        trackKnown: app.library.getTrack(id) !== null
      })
    }
    return original.call(fs, p, ...rest)
  })
  const r = await upload(port, 'durevole.wav', wav)
  assert.equal(r.status, 200)
  assert.deepEqual(seen, [{ fileInPlace: true, trackKnown: false }], 'one fsync of library/, after the rename, before addTrack')
})

test('upload: size limit enforced from Content-Length and while streaming', async (t) => {
  const { app, dir, port } = await start(t, { maxUpload: 64 * 1024 })
  const big = makeWav({ seconds: 8 }) // 128 KB

  const declared = await upload(port, 'grande.wav', big)
  assert.equal(declared.status, 413)

  // Chunked body (no Content-Length): the limit must trip while streaming.
  const status = await new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'PUT', path: '/api/upload/grande.wav', agent: false,
      headers: { 'transfer-encoding': 'chunked' }
    }, (res) => {
      res.resume()
      resolve(res.statusCode)
    })
    req.on('error', () => resolve('reset'))
    let off = 0
    const pump = () => {
      while (off < big.length) {
        const chunk = big.subarray(off, off + 8192)
        off += chunk.length
        if (!req.write(chunk)) return req.once('drain', pump)
      }
      req.end()
    }
    pump()
  })
  assert.equal(status, 413, 'the client reads the 413 even while still sending')
  await sleep(100)
  assert.deepEqual(fs.readdirSync(path.join(dir, 'tmp')), [], 'temp file removed')
  assert.equal(app.library.tracks.size, 0)
})

test('upload: a client that goes away mid-upload leaves no temp file', async (t) => {
  const { app, dir, port } = await start(t)
  const req = http.request({
    host: '127.0.0.1', port, method: 'PUT', path: '/api/upload/a.wav', agent: false,
    headers: { 'content-length': 1000000 }
  })
  req.on('error', () => {})
  req.write(makeWav({ seconds: 2 }).subarray(0, 20000))
  await sleep(150)
  assert.equal(fs.readdirSync(path.join(dir, 'tmp')).length, 1, 'the upload is being written')
  req.destroy()
  for (let i = 0; i < 50 && fs.readdirSync(path.join(dir, 'tmp')).length > 0; i++) await sleep(20)
  assert.deepEqual(fs.readdirSync(path.join(dir, 'tmp')), [])
  assert.equal(app.library.tracks.size, 0)
})

test('stream: Range, full body, HEAD, 416, conditional requests', async (t) => {
  const { port } = await start(t)
  const wav = makeWav({ seconds: 3, freq: 300 })
  const { track } = json(await upload(port, 's.wav', wav))
  const url = '/api/stream/' + track.id

  const full = await request(port, 'GET', url + '?f=' + track.fileHash)
  assert.equal(full.status, 200)
  assert.equal(full.headers['content-type'], 'audio/wav')
  assert.equal(full.headers['accept-ranges'], 'bytes')
  assert.equal(full.headers['cache-control'], 'private, max-age=31536000, immutable')
  assert.equal(Number(full.headers['content-length']), wav.length)
  assert.deepEqual(full.body, wav)

  const part = await request(port, 'GET', url, { headers: { range: 'bytes=1000-4999' } })
  assert.equal(part.status, 206)
  assert.equal(part.headers['content-range'], 'bytes 1000-4999/' + wav.length)
  assert.equal(Number(part.headers['content-length']), 4000)
  assert.deepEqual(part.body, wav.subarray(1000, 5000))

  const tail = await request(port, 'GET', url, { headers: { range: 'bytes=-100' } })
  assert.equal(tail.status, 206)
  assert.deepEqual(tail.body, wav.subarray(wav.length - 100))

  const open = await request(port, 'GET', url, { headers: { range: 'bytes=' + (wav.length - 10) + '-' } })
  assert.equal(open.status, 206)
  assert.deepEqual(open.body, wav.subarray(wav.length - 10))

  const bad = await request(port, 'GET', url, { headers: { range: 'bytes=' + wav.length + '-' } })
  assert.equal(bad.status, 416)
  assert.equal(bad.headers['content-range'], 'bytes */' + wav.length)

  const head = await request(port, 'HEAD', url)
  assert.equal(head.status, 200)
  assert.equal(Number(head.headers['content-length']), wav.length)
  assert.equal(head.body.length, 0)

  const cached = await request(port, 'GET', url, { headers: { 'if-none-match': full.headers.etag } })
  assert.equal(cached.status, 304)

  const staleIfRange = await request(port, 'GET', url, { headers: { range: 'bytes=0-9', 'if-range': '"other"' } })
  assert.equal(staleIfRange.status, 200, 'If-Range mismatch: whole file')

  const missing = await request(port, 'GET', '/api/stream/' + 'f'.repeat(24))
  assert.equal(missing.status, 404)
  assert.equal(missing.headers['content-type'], 'application/json; charset=utf-8')
})

test('library: gzip, ETag, 304, version bumps on change; health', async (t) => {
  const { app, port } = await start(t)
  const { track } = json(await upload(port, 'l.wav', makeWav({ freq: 250 })))

  const r = await request(port, 'GET', '/api/library', { headers: { 'accept-encoding': 'gzip, deflate' } })
  assert.equal(r.status, 200)
  assert.equal(r.headers['content-encoding'], 'gzip')
  assert.equal(r.headers['content-type'], 'application/json; charset=utf-8')
  const lib = JSON.parse(zlib.gunzipSync(r.body).toString('utf8'))
  assert.equal(lib.tracks.length, 1)
  assert.deepEqual(Object.keys(lib).sort(), ['covers', 'likes', 'playlists', 'recents', 'source', 'tracks', 'userVersion', 'version', 'you'])
  assert.deepEqual(lib.covers, { track: {}, album: {}, playlist: {} })
  assert.deepEqual(lib.tracks[0].qualities, { low: false, normal: false, high: false }, 'no ffmpeg: no Opus versions')
  assert.equal(lib.tracks[0].lossless, true, 'WAV is lossless')
  assert.deepEqual(lib.you, { profileId: null, role: 'owner' }, 'a local request is the owner')
  // Both versions and both epochs (a person with no data yet: version 0, the zero epoch).
  assert.equal(r.headers.etag, 'W/"owner.' + lib.version + '.' + lib.userVersion + '.' + app.library.epoch + '.0000000000000000"')

  const plain = await request(port, 'GET', '/api/library')
  assert.equal(plain.headers['content-encoding'], undefined)
  assert.equal(json(plain).version, lib.version)

  const again = await request(port, 'GET', '/api/library', { headers: { 'if-none-match': r.headers.etag } })
  assert.equal(again.status, 304)

  const liked = await request(port, 'PUT', '/api/likes/' + track.id)
  assert.equal(liked.status, 200)
  assert.equal(json(liked).likes[0].id, track.id)

  const changed = await request(port, 'GET', '/api/library', { headers: { 'if-none-match': r.headers.etag } })
  assert.equal(changed.status, 200)
  assert.equal(json(changed).version, lib.version, "a like is the person's data, not the shared library")
  // A person's first change opens its log's epoch: the version moves on from the clock.
  assert.ok(json(changed).userVersion > lib.userVersion, "the person's version moved")

  const health = json(await request(port, 'GET', '/api/health'))
  assert.deepEqual(Object.keys(health).sort(), ['archives', 'details', 'diskFreeBytes', 'ffmpeg', 'fpcalc', 'name', 'ok', 'places', 'server', 'social', 'tracks', 'version'])
  assert.equal(health.social, 3)
  assert.equal(health.ok, true)
  assert.equal(health.details, true, 'details from the network: on unless the owner turned them off')
  assert.equal(health.tracks, 1)
  assert.equal(health.version, lib.version)
  assert.equal(health.ffmpeg, false)
  assert.equal(health.fpcalc, false)
  assert.deepEqual(health.archives, { zip: true, sevenZip: false, rar: false })
  assert.equal(typeof health.name, 'string')
  assert.ok(health.name.length > 0)
  assert.match(health.server, /^\d+\.\d+\.\d+$/)
  assert.ok(Number.isFinite(health.diskFreeBytes) && health.diskFreeBytes > 0, 'free space: ' + health.diskFreeBytes)
})

test('api: playlists, track edit and delete over HTTP', async (t) => {
  const { dir, port } = await start(t)
  const { track: t1 } = json(await upload(port, 'uno.wav', makeWav({ freq: 100 })))
  const { track: t2 } = json(await upload(port, 'due.wav', makeWav({ freq: 200 })))

  const { playlist } = json(await request(port, 'POST', '/api/playlists', { body: { name: 'In auto' } }))
  assert.equal(playlist.name, 'In auto')
  let r = await request(port, 'POST', '/api/playlists/' + playlist.id + '/tracks', { body: { trackIds: [t1.id, t2.id, t1.id] } })
  assert.deepEqual(json(r).playlist.trackIds, [t1.id, t2.id, t1.id])
  r = await request(port, 'DELETE', '/api/playlists/' + playlist.id + '/tracks', { body: { indexes: [0] } })
  assert.deepEqual(json(r).playlist.trackIds, [t2.id, t1.id])
  r = await request(port, 'PATCH', '/api/playlists/' + playlist.id, { body: { trackIds: [t1.id, t2.id], description: 'Viaggi' } })
  assert.deepEqual(json(r).playlist.trackIds, [t1.id, t2.id])
  assert.equal(json(r).playlist.description, 'Viaggi')

  r = await request(port, 'PATCH', '/api/tracks/' + t1.id, { body: { title: 'Primo' } })
  assert.equal(json(r).track.title, 'Primo')
  r = await request(port, 'POST', '/api/played', { body: { trackId: t1.id, context: { type: 'playlist', id: playlist.id } } })
  assert.deepEqual(json(r), { ok: true })

  r = await request(port, 'DELETE', '/api/tracks/' + t1.id)
  assert.deepEqual(json(r), { ok: true, deleted: true })
  assert.ok(!fs.existsSync(shardPath(dir, 'library', t1.id + '.wav')))
  const lib = json(await request(port, 'GET', '/api/library'))
  assert.deepEqual(lib.playlists[0].trackIds, [t2.id])
  assert.equal(lib.recents.length, 0)

  r = await request(port, 'DELETE', '/api/playlists/' + playlist.id)
  assert.deepEqual(json(r), { ok: true })
  r = await request(port, 'POST', '/api/playlists', { body: '{not json', headers: { 'content-type': 'application/json' } })
  assert.equal(r.status, 400)
  assert.ok(json(r).error)
  r = await request(port, 'GET', '/api/nothing')
  assert.equal(r.status, 404)
})
