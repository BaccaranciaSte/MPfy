// The memory card away and back: its tracks are kept (away, never dropped,
// never adopted again as new), a start whose card is slow to mount writes
// nothing, deletions and replacements made meanwhile hold at its return, streams
// fall back or answer track_away (never 503), and nothing waits on a timer.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { tmpDir, cleanup, request, shardPath, treeFiles, waitFor, makeWav } from './helpers.mjs'
import { cardEnv, startWithCard, useCard, settle, logLines, hiWav, idOf, VOLUME } from './card-env.mjs'

function setup (t) {
  const c = cleanup(t)
  const dir = c.dir(tmpDir())
  const env = cardEnv(c, dir)
  return { c, dir, env }
}

const tombstones = (lines) => lines.filter((l) => l.length === 2 && String(l[1]).startsWith('t:'))
const away = (env) => fs.renameSync(env.vol, env.vol + '-out')
const back = (env) => fs.renameSync(env.vol + '-out', env.vol)

// A source whose card holds `n` tracks (moved there), stopped when `stop`.
async function withTracks (t, n = 3, { stop = true, freq = 300, seconds = 1 } = {}) {
  const { c, dir, env } = setup(t)
  const s = await startWithCard(c, env, dir)
  await useCard(s)
  const tracks = []
  for (let i = 0; i < n; i++) tracks.push(await s.upload('t' + i + '.wav', hiWav(freq + i * 13, seconds)))
  await settle(s.app)
  for (const tr of tracks) assert.ok(fs.existsSync(shardPath(env.root, 'library', tr.id + '.wav')), 'on the card')
  if (stop) await s.app.close()
  return { c, dir, env, s, tracks }
}

test('card away: its tracks stay, away, with their dates, uploaders and edits; back, nothing is adopted and the log has d: lines only', async (t) => {
  const { c, dir, env, tracks } = await withTracks(t, 3)
  // Edited while here, then the card leaves with the source stopped.
  const s1 = await startWithCard(c, env, dir)
  assert.equal((await s1.call('PATCH', '/api/tracks/' + tracks[0].id, { title: 'Titolo mio' })).status, 200)
  const kept = s1.app.library.publicTracks().map((x) => [x.id, x.addedAt, x.title])
  await s1.app.close()
  away(env)
  const lines = logLines(dir).length
  const s2 = await startWithCard(c, env, dir)
  assert.deepEqual(s2.app.library.publicTracks().map((x) => [x.id, x.addedAt, x.title]), kept, 'every track kept as it was')
  await waitFor(() => s2.app.library.awayIds().length === 3, { what: 'away after the grace' })
  assert.equal(tombstones(logLines(dir).slice(lines)).length, 0, 'no tombstone')
  assert.ok(s2.app.library.publicTracks().every((x) => x.away === true), 'away on the wire')
  assert.ok(s2.app.library.getTrack(tracks[1].id).uploaders.length > 0, 'the uploaders kept')
  const mid = logLines(dir).length
  back(env)
  await s2.app.places.recheck()
  await waitFor(() => s2.app.library.awayIds().length === 0, { what: 'back' })
  const added = logLines(dir).slice(mid)
  assert.ok(added.length > 0 && added.every((l) => String(l[1]).startsWith('d:')), 'd: lines only: ' + JSON.stringify(added.map((l) => l[1])))
  assert.deepEqual(s2.app.library.publicTracks().map((x) => [x.id, x.addedAt, x.title]), kept, 'the same tracks, nothing adopted')
})

test('card away: a card that shows within the grace writes nothing at the start', async (t) => {
  const { c, dir, env } = await withTracks(t, 2)
  away(env)
  const size = fs.statSync(path.join(dir, 'library.log')).size
  const s = await startWithCard(c, env, dir, { placesOptions: { graceMs: 1500 } })
  assert.equal(s.app.places.card.state, 'pending')
  back(env)
  await s.app.places.recheck()
  await waitFor(() => s.app.places.card.listed === 'ready', { what: 'the card listed' })
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(fs.statSync(path.join(dir, 'library.log')).size, size, 'the log as it was')
  assert.equal(s.app.library.awayIds().length, 0)
})

test('card away: a card that leaves and comes back inside 60 s writes nothing; away longer, one batch', async (t) => {
  const { c, dir, env } = await withTracks(t, 2)
  const s = await startWithCard(c, env, dir, { placesOptions: { graceMs: 400 } })
  const size = fs.statSync(path.join(dir, 'library.log')).size
  away(env)
  await s.app.places.recheck()
  assert.equal(s.app.places.card.state, 'away', 'serving stops at once')
  back(env)
  await s.app.places.recheck()
  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.equal(fs.statSync(path.join(dir, 'library.log')).size, size, 'a quick flap writes nothing')
  away(env)
  await s.app.places.recheck()
  await waitFor(() => s.app.library.awayIds().length === 2, { what: 'away for good' })
  const added = logLines(dir).filter((l) => l[0] > s.app.library.version - 1)
  assert.equal(new Set(added.map((l) => l[0])).size, 1, 'one batch')
})

test('card away: an I/O error under the card while a job reads from it is no failure, and the job runs again when the card is back', async (t) => {
  const { c, dir, env, tracks } = await withTracks(t, 1)
  const s = await startWithCard(c, env, dir)
  const id = tracks[0].id
  fs.unlinkSync(shardPath(dir, 'transcodes', id + '.normal.opus'))
  s.app.jobs.forget(id, 'normal')
  env.st.fail = () => 'EIO'
  s.app.jobs.requestTranscode(s.app.library.getTrack(id), 'normal')
  await settle(s.app)
  assert.equal(s.app.places.card.state, 'away')
  assert.equal(s.app.jobs.stats.failed, 0, 'not counted failed')
  assert.ok(!s.app.jobs._failedAt.has('t:' + id + '.normal'), 'not blocked')
  env.st.fail = null
  await s.app.places.recheck()
  await waitFor(() => fs.existsSync(shardPath(dir, 'transcodes', id + '.normal.opus')), { what: 'made at the return' })
})

test('card away: a track deleted meanwhile does not come back with the card, and its file there goes at the return', async (t) => {
  const { c, dir, env, tracks } = await withTracks(t, 2)
  away(env)
  const s = await startWithCard(c, env, dir)
  assert.equal((await s.call('DELETE', '/api/tracks/' + tracks[0].id)).status, 200)
  await s.app.close()
  back(env)
  const s2 = await startWithCard(c, env, dir)
  await settle(s2.app)
  assert.equal(s2.app.library.getTrack(tracks[0].id), null, 'not back')
  assert.ok(!fs.existsSync(shardPath(env.root, 'library', tracks[0].id + '.wav')), 'its file on the card gone')
  assert.ok(s2.app.library.getTrack(tracks[1].id) !== null)
})

test('card away: a deletion and a replacement by another format list the old names in gone at once; neither comes back, both files go at the return; no timer meanwhile', async (t) => {
  const { c, dir, env, tracks } = await withTracks(t, 2)
  away(env)
  const s = await startWithCard(c, env, dir)
  await waitFor(() => s.app.places.card.state === 'away', { what: 'away' })
  const timers = []
  const realSet = global.setTimeout
  global.setTimeout = function (fn, ms, ...rest) {
    const h = realSet(fn, ms, ...rest)
    timers.push({ ms, stack: new Error().stack })
    return h
  }
  let lib
  try {
    lib = s.app.library
    lib.deleteTrack(tracks[0].id)
    const tmp = path.join(lib.tmpDir, 'nuovo.flac')
    fs.writeFileSync(tmp, 'flac bytes')
    lib.replaceFile(tracks[1].id, tmp, { format: 'flac', fileHash: idOf(Buffer.from('flac bytes')), size: 10 }, {})
  } finally {
    global.setTimeout = realSet
  }
  assert.deepEqual(timers.filter((x) => /library\.mjs/.test(x.stack) && /_sweepLater/.test(x.stack)), [], 'no retry timer of gone')
  const g = logLines(dir).filter((l) => l[1] === 'g').pop()
  assert.deepEqual(g[2].sort(), [tracks[0].id + '.wav', tracks[1].id + '.wav'].sort(), 'both old names in gone')
  await s.app.close()
  back(env)
  const s2 = await startWithCard(c, env, dir)
  await settle(s2.app)
  assert.equal(s2.app.library.getTrack(tracks[0].id), null)
  assert.equal(s2.app.library.getTrack(tracks[1].id).format, 'flac', 'the new file kept')
  const left = treeFiles(env.root, 'library')
  assert.ok(!left.includes(tracks[0].id + '.wav') && !left.includes(tracks[1].id + '.wav'), 'both old files gone: ' + left)
  assert.deepEqual(s2.app.library._gone.size, 0, 'gone swept')
})

test('card away: a track replaced meanwhile by the same format keeps its new file; the card\'s old copy goes at the return', async (t) => {
  const { c, dir, env, tracks } = await withTracks(t, 1)
  away(env)
  const s = await startWithCard(c, env, dir)
  const lib = s.app.library
  const fresh = makeWav({ seconds: 2, freq: 999 })
  const tmp = path.join(lib.tmpDir, 'nuovo.wav')
  fs.writeFileSync(tmp, fresh)
  lib.replaceFile(tracks[0].id, tmp, { fileHash: idOf(fresh), size: fresh.length }, {})
  await s.app.close()
  back(env)
  const s2 = await startWithCard(c, env, dir)
  await settle(s2.app)
  const now = s2.app.library.getTrack(tracks[0].id)
  assert.equal(now.fileHash, idOf(fresh))
  assert.deepEqual(fs.readFileSync(s2.app.library.trackPath(now)), fresh, 'the new bytes are the track')
  assert.ok(!fs.existsSync(shardPath(env.root, 'library', tracks[0].id + '.wav')) || fs.readFileSync(shardPath(env.root, 'library', tracks[0].id + '.wav')).equals(fresh), 'the old copy gone')
})

test('card away: two whole copies (a move cut after its rename): the start keeps the card copy of an original and the internal copy of a transcode', async (t) => {
  const { c, dir, env, tracks } = await withTracks(t, 1)
  const id = tracks[0].id
  fs.copyFileSync(shardPath(env.root, 'library', id + '.wav'), shardPath(dir, 'library', id + '.wav'))
  const tr = shardPath(env.root, 'transcodes', id + '.low.opus')
  fs.mkdirSync(path.dirname(tr), { recursive: true })
  fs.copyFileSync(shardPath(dir, 'transcodes', id + '.low.opus'), tr)
  const s = await startWithCard(c, env, dir)
  await settle(s.app)
  assert.ok(fs.existsSync(shardPath(env.root, 'library', id + '.wav')), 'the original on the card stays')
  assert.ok(!fs.existsSync(shardPath(dir, 'library', id + '.wav')), 'its internal copy goes')
  assert.ok(fs.existsSync(shardPath(dir, 'transcodes', id + '.low.opus')), 'the internal transcode stays')
  await waitFor(() => !fs.existsSync(tr), { what: 'the card transcode gone' })
})

test('card away: q=max of an away track falls back to its best ready level (no-cache); with none, 404 track_away; never 503', async (t) => {
  const { c, dir, env, tracks } = await withTracks(t, 2)
  const s = await startWithCard(c, env, dir)
  for (const lv of ['low', 'normal', 'high']) {
    const f = shardPath(dir, 'transcodes', tracks[1].id + '.' + lv + '.opus')
    if (fs.existsSync(f)) fs.unlinkSync(f)
    s.app.jobs.forget(tracks[1].id, lv)
  }
  const high = shardPath(dir, 'transcodes', tracks[0].id + '.high.opus')
  fs.unlinkSync(high)
  s.app.jobs.forget(tracks[0].id, 'high')
  away(env)
  await s.app.places.recheck()
  const r = await request(s.app.ports.http, 'GET', '/api/stream/' + tracks[0].id + '?q=max')
  assert.equal(r.status, 200)
  assert.equal(r.headers['x-mpfy-quality'], 'normal')
  assert.equal(r.headers['cache-control'], 'no-cache')
  const none = await request(s.app.ports.http, 'GET', '/api/stream/' + tracks[1].id + '?q=max')
  assert.equal(none.status, 404)
  assert.equal(JSON.parse(none.body).code, 'track_away')
  assert.equal(JSON.parse(none.body).error, 'Brano non disponibile ora')
})

test('card away: a playback of the original keeps it while here; once away, from byte 0 the ready level, a continuation track_away', async (t) => {
  const { c, dir, env, tracks } = await withTracks(t, 1)
  const s = await startWithCard(c, env, dir)
  const id = tracks[0].id
  const first = await request(s.app.ports.http, 'GET', '/api/stream/' + id + '?q=max', { headers: { range: 'bytes=0-' } })
  assert.equal(first.headers['x-mpfy-quality'], 'max')
  away(env)
  await s.app.places.recheck()
  const cont = await request(s.app.ports.http, 'GET', '/api/stream/' + id + '?q=max', { headers: { range: 'bytes=1000-' } })
  assert.equal(cont.status, 404)
  assert.equal(JSON.parse(cont.body).code, 'track_away')
  const again = await request(s.app.ports.http, 'GET', '/api/stream/' + id + '?q=max', { headers: { range: 'bytes=0-' } })
  assert.equal(again.status, 206)
  assert.notEqual(again.headers['x-mpfy-quality'], 'max')
})

test('card away: a response being sent from a card file is cut at once when the card leaves', async (t) => {
  // Long enough (about 26 MB) for the response to wait on a reader that does not read.
  const { c, dir, env, tracks } = await withTracks(t, 1, { freq: 500, seconds: 300 })
  const s = await startWithCard(c, env, dir)
  const id = tracks[0].id
  const closed = new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: s.app.ports.http, path: '/api/stream/' + id + '?q=max', agent: false }, (res) => {
      res.pause()
      res.once('close', () => resolve('closed'))
      res.once('error', () => resolve('closed'))
      res.once('aborted', () => resolve('closed'))
    })
    req.on('error', () => resolve('closed'))
    req.on('socket', (sock) => sock.once('close', () => resolve('closed')))
  })
  await waitFor(() => s.app.places._streams.size === 1, { what: 'the card stream open' })
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(s.app.places._streams.size, 1, 'still being sent: the reader does not read')
  const sending = [...s.app.places._streams][0]
  away(env)
  const t0 = Date.now()
  await s.app.places.recheck()
  // Cut on our side at once (a player that reads on gets the end of the stream, then fails over).
  await waitFor(() => sending.owner.destroyed && (!sending.owner.socket || sending.owner.socket.destroyed), { what: 'the response cut', timeout: 1000 })
  assert.ok(Date.now() - t0 < 1000)
  void closed
})

test('card away: forget takes its tracks out (the lists keep the ids) writing nothing on the card; using it again brings them back with their ids', async (t) => {
  const { c, dir, env, tracks } = await withTracks(t, 2)
  const s = await startWithCard(c, env, dir)
  env.st.log.length = 0
  const r = await s.call('PUT', '/api/admin/storage', { forget: true })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(s.app.library.tracks.size, 0)
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'source.json'), 'utf8')).card ?? null, null)
  assert.deepEqual(env.st.log, [], 'nothing written on the card by the forget')
  assert.ok(fs.existsSync(path.join(env.root, 'place.json')), 'the marker stays')
  for (const x of tracks) assert.ok(fs.existsSync(shardPath(env.root, 'library', x.id + '.wav')), 'its files stay')
  const use = await s.call('PUT', '/api/admin/storage', { use: VOLUME })
  assert.equal(use.status, 200, JSON.stringify(use.body))
  await settle(s.app)
  assert.deepEqual([...s.app.library.tracks.keys()].sort(), tracks.map((x) => x.id).sort(), 'the same ids')
})

test('card away: at the return an unknown file is adopted at the end (no reorder), a file in gone is not and goes', async (t) => {
  const { c, dir, env, tracks } = await withTracks(t, 2)
  away(env)
  const s = await startWithCard(c, env, dir)
  await waitFor(() => s.app.places.card.state === 'away', { what: 'away' })
  s.app.library.deleteTrack(tracks[0].id)
  back(env)
  // A file of this source the log does not know (a crash right after a commit).
  const extra = makeWav({ seconds: 1, freq: 1234 })
  const xid = idOf(extra)
  const f = shardPath(env.root, 'library', xid + '.wav')
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, extra)
  fs.utimesSync(f, new Date(1000), new Date(1000))
  const v = s.app.library.version
  await s.app.places.recheck()
  await waitFor(() => s.app.library.getTrack(xid) !== null, { what: 'adopted' })
  assert.deepEqual([...s.app.library.tracks.keys()].pop(), xid, 'at the end, though older')
  assert.ok(!logLines(dir).some((l) => l[0] > v && l[1] === 'z'), 'no reorder')
  assert.equal(s.app.library.getTrack(tracks[0].id), null)
  assert.ok(!fs.existsSync(shardPath(env.root, 'library', tracks[0].id + '.wav')), 'the file in gone went')
})

test('card away: a level spilled onto a card slow to mount keeps its bit at the start, and nothing is written when the card shows', async (t) => {
  const { c, dir, env, tracks } = await withTracks(t, 1)
  const id = tracks[0].id
  const tr = shardPath(env.root, 'transcodes', id + '.normal.opus')
  fs.mkdirSync(path.dirname(tr), { recursive: true })
  fs.renameSync(shardPath(dir, 'transcodes', id + '.normal.opus'), tr)
  away(env)
  const size = fs.statSync(path.join(dir, 'library.log')).size
  const s = await startWithCard(c, env, dir, { placesOptions: { graceMs: 2000 } })
  assert.equal(fs.statSync(path.join(dir, 'library.log')).size, size, 'the start wrote nothing')
  back(env)
  await s.app.places.recheck()
  await waitFor(() => s.app.places.card.listed === 'ready', { what: 'listed' })
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(fs.statSync(path.join(dir, 'library.log')).size, size, 'nor its return')
  assert.equal(s.app.library.publicTrack(s.app.library.getTrack(id)).qualities.normal, true)
})

test('card away: a card mounted right after the start\'s check is seen by the folder event, with no timer of ours', async (t) => {
  const { c, dir, env } = await withTracks(t, 1)
  away(env)
  // The card mounted right as the first look at it found nothing.
  let first = true
  const devOf = env.io.devOf
  env.io.devOf = async (p) => {
    try {
      return await devOf(p)
    } catch (err) {
      if (first && p.endsWith(VOLUME)) {
        first = false
        back(env)
      }
      throw err
    }
  }
  const s = await startWithCard(c, env, dir, { placesOptions: { watch: true, graceMs: 5000, afterEventMs: [50, 200] } })
  await waitFor(() => s.app.places.card.state === 'ready', { what: 'ready by the event', timeout: 4000 })
})

test('card away: a shard of the card unreadable at the start drops none of its tracks', async (t) => {
  const { c, dir, env, tracks } = await withTracks(t, 3)
  const bad = tracks[0].id.slice(0, 2)
  env.st.fail = (op, p) => (op === 'readdir' && path.basename(p) === bad && p.includes(path.join('MPfy', 'library')) ? 'EIO' : null)
  const lines = logLines(dir).length
  const s = await startWithCard(c, env, dir)
  assert.equal(s.app.library.tracks.size, 3, 'none dropped')
  assert.equal(tombstones(logLines(dir).slice(lines)).length, 0)
})
