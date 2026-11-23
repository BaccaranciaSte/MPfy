// Each person's data on a shared library: playlists, likes, recents and
// playlist covers per profile (ETag per profile, ?have= for the shared part),
// tracks with `mine` and `others` (never `uploaders`), what a member may edit,
// cover or delete, album covers by the web's album id, playlists created under
// a given id; the fingerprint signature in the library, the fingerprint
// endpoint, and the stream's ?f= and ETag.

import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import v8 from 'node:v8'
import vm from 'node:vm'
import zlib from 'node:zlib'
import { createMPfy } from '../server/app.mjs'
import { albumIdOf } from '../server/ids.mjs'
import { hashId } from '../web/js/util.js'
import { tmpDir, cleanup, request, json, makeWav, makeProfile, device, testWhoIs, fakeTool, fakeFfmpeg, hash24, shardPath } from './helpers.mjs'

const body = (r) => json(r)
const jpeg = (n) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(n), Buffer.from([0xff, 0xd9])])

async function start (t, opts = {}) {
  const c = cleanup(t)
  const dir = opts.dir || c.dir(tmpDir())
  const app = c.close(await createMPfy({
    dataDir: dir, port: 0, adminPort: 0, p2p: false, debounceMs: 10, ffmpeg: null, fpcalc: null, sevenZip: null, whoIs: testWhoIs, ...opts
  }))
  if (opts.restart) return { app, dir, port: app.ports.http }
  app.people.openClaim(30)
  const owner = device(app, { profile: makeProfile(), name: 'Bacca' })
  assert.equal(body(await owner.call('GET', '/api/profile')).role, 'owner')
  return { app, dir, port: app.ports.http, owner }
}

test('user data: two profiles never see each other\'s playlists, likes, recents, playlist covers; ETag per profile; ?have= answers tracks: null', async (t) => {
  const { app, owner } = await start(t)
  const sara = device(app, { profile: makeProfile() })
  const track = body(await owner.call('PUT', '/api/upload/a.wav', { body: makeWav({ freq: 300 }) })).track
  const pl = body(await owner.call('POST', '/api/playlists', { body: { name: 'Di Bacca' } })).playlist
  await owner.call('PUT', '/api/likes/' + track.id)
  await owner.call('POST', '/api/played', { body: { trackId: track.id } })
  assert.equal((await owner.call('PUT', '/api/cover-for/playlist/' + pl.id + '?size=small', { body: jpeg(50) })).status, 200)
  // Sara cannot touch it: it is not hers.
  for (const [method, url, b] of [['PATCH', '/api/playlists/' + pl.id, { name: 'Mia' }], ['DELETE', '/api/playlists/' + pl.id], ['PUT', '/api/cover-for/playlist/' + pl.id + '?size=small', jpeg(10)], ['DELETE', '/api/cover-for/playlist/' + pl.id]]) {
    const r = await sara.call(method, url, { body: b || null })
    assert.equal(r.status, 404, method + ' ' + url)
    assert.equal(body(r).error, 'Playlist non trovata')
  }
  const mine = body(await owner.call('GET', '/api/library'))
  const hers = body(await sara.call('GET', '/api/library'))
  assert.deepEqual(mine.playlists.map((p) => p.name), ['Di Bacca'])
  assert.deepEqual(mine.likes.map((l) => l.id), [track.id])
  assert.equal(mine.recents.length, 1)
  assert.deepEqual(Object.keys(mine.covers.playlist), [pl.id])
  assert.deepEqual([hers.playlists, hers.likes, hers.recents, hers.covers.playlist], [[], [], [], {}])
  assert.equal(hers.tracks.length, 1, 'the library is shared')
  assert.equal(hers.version, mine.version)

  const a = await owner.call('GET', '/api/library')
  const b = await sara.call('GET', '/api/library')
  assert.notEqual(a.headers.etag, b.headers.etag)
  // Both versions and both epochs: the library's and the person's.
  const epochs = '.' + app.library.epoch + '.' + app.users.get(owner.profile.id).epoch
  assert.equal(a.headers.etag, 'W/"' + owner.profile.id + '.' + mine.version + '.' + mine.userVersion + epochs + '"')
  assert.equal((await sara.call('GET', '/api/library', { headers: { 'if-none-match': a.headers.etag } })).status, 200, 'another profile never gets a 304 on my ETag')
  // The owner from 127.0.0.1 reads the same data, as the owner without a profile.
  const local = await request(app.ports.http, 'GET', '/api/library')
  assert.equal(local.headers.etag, 'W/"owner.' + mine.version + '.' + mine.userVersion + epochs + '"')
  assert.deepEqual(body(local).you, { profileId: null, role: 'owner' })
  assert.deepEqual(body(local).playlists, mine.playlists)
  assert.deepEqual(body(await owner.call('GET', '/api/library')).you, { profileId: owner.profile.id, role: 'owner' }, 'each keeps its own answer')

  // ?have= with the current shared version: the user part only.
  const fresh = await owner.call('GET', '/api/library?have=' + mine.version, { headers: { 'accept-encoding': 'gzip' } })
  const f = JSON.parse(zlib.gunzipSync(fresh.body).toString('utf8'))
  assert.equal(f.tracks, null)
  assert.deepEqual(f.covers, { playlist: mine.covers.playlist })
  assert.deepEqual(f.likes, mine.likes)
  assert.equal(fresh.headers.etag, a.headers.etag)
  const old = body(await owner.call('GET', '/api/library?have=' + (mine.version - 1)))
  assert.equal(old.tracks.length, 1, 'an old version gets every track')
  assert.deepEqual(Object.keys(old.covers).sort(), ['album', 'playlist', 'track'])
  // A play is the person's data: the shared version stays.
  await owner.call('POST', '/api/played', { body: { trackId: track.id } })
  const after = body(await owner.call('GET', '/api/library?have=' + mine.version))
  assert.equal(after.tracks, null)
  assert.equal(after.userVersion, mine.userVersion + 1)
})

test('tracks: mine and others, never uploaders; a member edits, covers and deletes only its own; a claim-only delete touches nothing else; the last claim deletes the file; the owner deletes for all', async (t) => {
  const { app, dir, owner } = await start(t)
  const sara = device(app, { profile: makeProfile(), name: 'Sara' })
  const marco = device(app, { profile: makeProfile(), name: 'Marco' })
  const wav = makeWav({ freq: 512 })
  const hersOnly = body(await sara.call('PUT', '/api/upload/s.wav', { body: makeWav({ freq: 513 }) })).track
  const shared = body(await sara.call('PUT', '/api/upload/c.wav', { body: wav })).track
  const again = body(await marco.call('PUT', '/api/upload/c2.wav', { body: wav }))
  assert.equal(again.outcome, 'duplicate')
  assert.equal(again.duplicate, true)
  assert.equal(again.track.mine, true, 'a duplicate upload makes it his too')
  assert.equal(again.track.others, true)

  const lib = body(await sara.call('GET', '/api/library'))
  for (const tr of lib.tracks) assert.equal(tr.uploaders, undefined, 'uploaders never leave the source')
  const byId = Object.fromEntries(lib.tracks.map((x) => [x.id, x]))
  assert.deepEqual([byId[hersOnly.id].mine, byId[hersOnly.id].others], [true, false])
  assert.deepEqual([byId[shared.id].mine, byId[shared.id].others], [true, true])
  const ownerView = Object.fromEntries(body(await owner.call('GET', '/api/library')).tracks.map((x) => [x.id, x]))
  assert.deepEqual([ownerView[hersOnly.id].mine, ownerView[hersOnly.id].others], [false, true])

  // Marco cannot edit, cover or delete Sara's own track.
  for (const [method, url, b] of [['PATCH', '/api/tracks/' + hersOnly.id, { title: 'x' }], ['DELETE', '/api/tracks/' + hersOnly.id], ['PUT', '/api/cover-for/track/' + hersOnly.id + '?size=large', jpeg(10)], ['DELETE', '/api/cover-for/track/' + hersOnly.id]]) {
    const r = await marco.call(method, url, { body: b || null })
    assert.equal(r.status, 403, method + ' ' + url)
    assert.equal(body(r).code, 'forbidden')
  }
  assert.equal(body(await marco.call('PATCH', '/api/tracks/' + shared.id, { body: { title: 'Condiviso' } })).track.title, 'Condiviso', 'the shared one is his too')
  assert.equal((await marco.call('PUT', '/api/cover-for/track/' + shared.id + '?size=large', { body: jpeg(30) })).status, 200)

  // Sara likes and lists the shared track; Marco removes his claim: nothing else changes.
  await sara.call('PUT', '/api/likes/' + shared.id)
  const p = body(await sara.call('POST', '/api/playlists', { body: { name: 'P' } })).playlist
  await sara.call('POST', '/api/playlists/' + p.id + '/tracks', { body: { trackIds: [shared.id] } })
  await marco.call('PUT', '/api/likes/' + shared.id)
  let r = await marco.call('DELETE', '/api/tracks/' + shared.id)
  assert.deepEqual(body(r), { ok: true, deleted: false })
  assert.ok(fs.existsSync(shardPath(dir, 'library', shared.id + '.wav')), 'the file stays')
  assert.deepEqual(body(await marco.call('GET', '/api/library')).likes.map((l) => l.id), [shared.id], 'his own like is not touched either')
  assert.equal(body(await marco.call('GET', '/api/library')).tracks.find((x) => x.id === shared.id).mine, false)
  // Sara's delete is the last claim: the file goes, and the id leaves every person's data.
  r = await sara.call('DELETE', '/api/tracks/' + shared.id)
  assert.deepEqual(body(r), { ok: true, deleted: true })
  assert.ok(!fs.existsSync(shardPath(dir, 'library', shared.id + '.wav')))
  assert.deepEqual(body(await sara.call('GET', '/api/library')).playlists[0].trackIds, [])
  assert.deepEqual(body(await marco.call('GET', '/api/library')).likes, [])

  // The owner deletes anyone's track for everyone.
  await sara.call('PUT', '/api/likes/' + hersOnly.id)
  r = await owner.call('DELETE', '/api/tracks/' + hersOnly.id)
  assert.deepEqual(body(r), { ok: true, deleted: true })
  assert.deepEqual(body(await sara.call('GET', '/api/library')).likes, [])
  assert.equal(app.library.tracks.size, 0)
})

test('album covers: a member only when every track of the album on this source is theirs (album id as the web computes it)', async (t) => {
  const { app, owner } = await start(t)
  const sara = device(app, { profile: makeProfile() })
  const tags = { title: 'Uno', artist: 'NEA', album: 'Blue Regret' }
  const one = body(await sara.call('PUT', '/api/upload/1.wav', { body: makeWav({ freq: 201, tags }) })).track
  const albumId = albumIdOf(one)
  assert.equal(albumId, hashId((one.albumArtist || one.artist) + '\u0000' + one.album), 'the web\'s FNV-1a 64')
  let r = await sara.call('PUT', '/api/cover-for/album/' + albumId + '?size=large', { body: jpeg(40) })
  assert.equal(r.status, 200, 'every track of the album is hers')
  body(await owner.call('PUT', '/api/upload/2.wav', { body: makeWav({ freq: 202, tags: { ...tags, title: 'Due' } }) }))
  r = await sara.call('PUT', '/api/cover-for/album/' + albumId + '?size=large', { body: jpeg(40) })
  assert.equal(r.status, 403, 'one track of the album is not hers')
  assert.equal((await sara.call('DELETE', '/api/cover-for/album/' + albumId)).status, 403)
  assert.equal((await sara.call('PUT', '/api/cover-for/album/' + '0123456789abcdef' + '?size=large', { body: jpeg(4) })).status, 403, 'an album with no track here is nobody\'s')
  assert.equal((await owner.call('PUT', '/api/cover-for/album/' + '0123456789abcdef' + '?size=large', { body: jpeg(4) })).status, 200, 'the owner: any album')
  r = await owner.call('DELETE', '/api/cover-for/album/' + albumId)
  assert.equal(r.status, 200)
  assert.deepEqual(Object.keys(body(r).covers).sort(), ['album', 'playlist', 'track'])
})

test('playlists: created under a given id; the same id again is 409 playlist_exists, also for another profile', async (t) => {
  const { app, owner } = await start(t)
  const sara = device(app, { profile: makeProfile() })
  const id = 'abcdef0123456789'
  let r = await owner.call('POST', '/api/playlists', { body: { id, name: 'Viaggio' } })
  assert.equal(r.status, 200)
  assert.equal(body(r).playlist.id, id)
  for (const d of [owner, sara]) {
    r = await d.call('POST', '/api/playlists', { body: { id, name: 'Copia' } })
    assert.equal(r.status, 409)
    assert.deepEqual(body(r), { error: "Playlist gia' presente", code: 'playlist_exists' })
  }
  assert.equal(body(await sara.call('GET', '/api/library')).playlists.length, 0, 'nothing created')
  assert.equal((await owner.call('POST', '/api/playlists', { body: { id: 'XYZ' } })).status, 400)
})

test('fingerprints in the library and their endpoint; stream ?f= and the original\'s ETag; a Range without If-Range is 206', async (t) => {
  const work = cleanup(t).dir(tmpDir('mpfy-fp-'))
  const fpcalc = fakeTool(work, 'fpcalc')
  const wav = makeWav({ freq: 610, seconds: 3 })
  const items = Array.from({ length: 200 }, (_, i) => (i * 2654435761) >>> 0)
  fpcalc.control({ prints: { [hash24(wav)]: { duration: 3.04, fingerprint: items.map((x) => x | 0) } } })
  const { app, owner } = await start(t, { fpcalc: fpcalc.command })
  const track = body(await owner.call('PUT', '/api/upload/f.wav', { body: wav })).track
  assert.equal(track.fileHash, track.id)
  const fp = body(await owner.call('GET', '/api/library')).tracks[0].fp
  assert.equal(fp.d, 3, 'the track\'s duration, one decimal')
  assert.equal(fp.b, 32, 'past the first 4 s')
  const sig = Buffer.from(fp.s, 'base64')
  assert.equal(fp.s.length, 344)
  for (let j = 0; j < 64; j++) assert.equal(sig.readUInt32LE(j * 4), items[32 + j], '64 consecutive items, u32 LE')

  let r = await owner.call('GET', '/api/fingerprint/' + track.id + '?f=' + track.fileHash)
  assert.equal(r.status, 200)
  assert.match(r.headers['cache-control'], /immutable/)
  const raw = Buffer.from(body(r).fp, 'base64')
  assert.equal(raw.length, 800)
  assert.equal(raw.readUInt32LE(4 * 7), items[7])
  assert.deepEqual({ ...body(r), fp: undefined }, { trackId: track.id, fileHash: track.fileHash, d: 3.04, step: 0.12381, fp: undefined })
  r = await owner.call('GET', '/api/fingerprint/' + track.id + '?f=' + 'e'.repeat(24))
  assert.equal(r.status, 404)
  assert.equal(body(r).code, 'version_gone')
  assert.equal((await owner.call('GET', '/api/fingerprint/' + track.id)).headers['cache-control'], 'no-cache')

  r = await owner.call('GET', '/api/stream/' + track.id + '?q=max&f=' + 'e'.repeat(24))
  assert.equal(r.status, 404)
  assert.deepEqual(body(r), { error: 'Brano non trovato', code: 'version_gone' })
  r = await owner.call('GET', '/api/stream/' + track.id + '?q=max&f=' + track.fileHash, { headers: { range: 'bytes=100-' } })
  assert.equal(r.status, 206)
  assert.equal(r.headers.etag, '"' + track.fileHash + '"')
  assert.match(r.headers['cache-control'], /immutable/)
  assert.ok(r.body.equals(wav.subarray(100)))
  // No fingerprint at all: 404 with its own words.
  const other = body(await owner.call('PUT', '/api/upload/g.wav', { body: makeWav({ freq: 611 }) })).track
  fpcalc.control({ fail: [other.id] })
  const third = body(await owner.call('PUT', '/api/upload/h.wav', { body: makeWav({ freq: 612 }) })).track
  assert.equal(third.fp !== null, true)
  fpcalc.control({ default: 'fail' })
  const none = body(await owner.call('PUT', '/api/upload/i.wav', { body: makeWav({ freq: 613 }) })).track
  assert.equal(none.fp, null)
  r = await owner.call('GET', '/api/fingerprint/' + none.id)
  assert.equal(r.status, 404)
  assert.equal(body(r).error, 'Impronta non disponibile')
  assert.equal(app.library.getTrack(none.id).fpState, 'failed')
})

test('the background job fingerprints tracks without one and fills quality fields; ffmpeg analyses the files', async (t) => {
  const work = cleanup(t).dir(tmpDir('mpfy-bg-'))
  const fpcalc = fakeTool(work, 'fpcalc')
  const ff = fakeFfmpeg(work, { pcm: { cutoffHz: 17000, floorDb: -95 } })
  const dir = cleanup(t).dir(tmpDir())
  // Upload without fpcalc and ffmpeg, then restart with both.
  let { app, owner } = await start(t, { dir })
  const wav = body(await owner.call('PUT', '/api/upload/w.wav', { body: makeWav({ freq: 404, sampleRate: 44100 }) })).track
  assert.equal(wav.fp, null)
  assert.equal(app.library.getTrack(wav.id).fpState, 'none')
  assert.equal(app.library.getTrack(wav.id).qualityV, 0, 'no ffmpeg: not analysed')
  await app.close()
  app = (await start(t, { dir, fpcalc: fpcalc.command, ffmpeg: ff.command, restart: true })).app
  await app.jobsStarted
  await app.jobs.idle()
  const tr = app.library.getTrack(wav.id)
  assert.equal(tr.fpState, 'ok')
  assert.ok(tr.fp && tr.fp.s.length > 0)
  assert.equal(tr.qualityV, 2)
  assert.equal(tr.cutoffHz, 17000)
  assert.equal(tr.fakeLossless, true, 'no energy above 17 kHz: made from a 128 kbps mp3')
  assert.equal(tr.equivKbps, 128)
  assert.equal(tr.score, 128)
  assert.equal(app.jobs.stats.fingerprints, 1)
  assert.equal(app.jobs.stats.qualityChecks, 1)
})

test('library: a "$" in a title is kept as it is, and the body stays JSON', async (t) => {
  const { owner } = await start(t)
  const track = body(await owner.call('PUT', '/api/upload/a.wav', { body: makeWav({ freq: 377 }) })).track
  const title = "Cash $& Co $' $` $$ $1"
  assert.equal((await owner.call('PATCH', '/api/tracks/' + track.id, { body: { title } })).status, 200)
  const lib = body(await owner.call('GET', '/api/library'))
  assert.equal(lib.tracks[0].title, title)
  assert.equal(lib.tracks.length, 1)
  assert.deepEqual(lib.you, { profileId: owner.profile.id, role: 'owner' })
})

test('library: after set-owner and a rename the old ETag gets the new role and name, never a 304', async (t) => {
  const { app, owner } = await start(t)
  const sara = device(app, { profile: makeProfile(), name: 'Sara' })
  let r = await sara.call('GET', '/api/library')
  const before = r.headers.etag
  assert.equal(body(r).you.role, 'member')
  assert.equal((await request(app.ports.http, 'POST', '/api/admin/owner', { body: { profileId: sara.profile.id } })).status, 200)
  r = await sara.call('GET', '/api/library', { headers: { 'if-none-match': before } })
  assert.equal(r.status, 200, 'the role changed')
  assert.equal(body(r).you.role, 'owner')
  assert.notEqual(r.headers.etag, before)
  r = await owner.call('GET', '/api/library')
  assert.equal(body(r).you.role, 'member', 'and the old owner is a member now')

  const tag = r.headers.etag
  const name = body(r).source
  assert.equal((await sara.call('PATCH', '/api/admin/source', { body: { name: 'Nuovo nome' } })).status, 200)
  r = await owner.call('GET', '/api/library', { headers: { 'if-none-match': tag } })
  assert.equal(r.status, 200)
  assert.deepEqual(body(r).source, { name: 'Nuovo nome', named: true, details: true, social: 3 })
  assert.notDeepEqual(name, body(r).source)

  // source.json edited by hand while the server runs: read again, the old ETag is stale too.
  const stale = r.headers.etag
  const src = JSON.parse(fs.readFileSync(app.source.file, 'utf8'))
  fs.writeFileSync(app.source.file, JSON.stringify({ ...src, name: 'Scritto a mano' }))
  r = await owner.call('GET', '/api/library', { headers: { 'if-none-match': stale } })
  assert.equal(r.status, 200)
  assert.equal(body(r).source.name, 'Scritto a mano')
})

test('library: the tracks are kept once for every caller, not once per caller', async (t) => {
  const { app, owner } = await start(t)
  v8.setFlagsFromString('--expose-gc')
  const gc = vm.runInNewContext('gc')
  // A big library without files: only /api/library reads it.
  const long = 'x'.repeat(2000)
  for (let i = 0; i < 1500; i++) {
    const id = crypto.createHash('sha256').update('big:' + i).digest('hex').slice(0, 24)
    app.library.addTrack({ id, title: long + i, format: 'mp3', size: 1, duration: 60, addedAt: 1, uploaders: [i % 2 ? owner.profile.id : 'f'.repeat(32)] })
  }
  const people = []
  for (let i = 0; i < 16; i++) people.push(device(app, { profile: makeProfile() }))
  const one = (await people[0].call('GET', '/api/library')).body.length
  gc()
  const heap0 = process.memoryUsage().heapUsed
  for (const p of people.slice(1)) {
    const lib = body(await p.call('GET', '/api/library'))
    assert.equal(lib.tracks.length, 1500)
    assert.equal(lib.tracks.filter((x) => x.mine).length, 0)
  }
  const counts = (lib) => [lib.tracks.filter((x) => x.mine).length, lib.tracks.filter((x) => x.others).length]
  assert.deepEqual(counts(body(await owner.call('GET', '/api/library'))), [750, 750])
  gc()
  const grown = process.memoryUsage().heapUsed - heap0
  t.diagnostic('body ' + one + ' bytes, heap grown by ' + grown + ' bytes after 16 more callers')
  assert.ok(grown < 3 * one, 'heap grew by ' + grown + ' for a body of ' + one)
})
