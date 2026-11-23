// The memory card: found and offered, chosen by the owner only (its marker
// proves it), floors of its own, the music moved onto it and back by copies
// that are read back from the card before the original goes, and no tool and
// no unbounded wait ever holding a card file.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { MAX_UPLOAD_BYTES, MAX_ARCHIVE_BYTES } from '../server/upload.mjs'
import { LIMITS } from '../server/sevenzip.mjs'
import { Places } from '../server/places.mjs'
import { runCommand, exportCompat } from '../server/index.mjs'
import { tmpDir, cleanup, device, makeProfile, shardPath, treeFiles, waitFor, request } from './helpers.mjs'
import { cardEnv, startWithCard, useCard, settle, logLines, hiWav, idOf, GIB, VOLUME } from './card-env.mjs'

function setup (t) {
  const c = cleanup(t)
  const dir = c.dir(tmpDir())
  const env = cardEnv(c, dir)
  return { c, dir, env }
}

const writesUnder = (env, prefix) => env.st.log.filter((l) => !l.startsWith('fsync') && l.includes(prefix))

test('card: a card found is offered by GET /api/admin/storage and `card`, and an upload stays in internal memory until the owner chooses it', async (t) => {
  const { c, dir, env } = setup(t)
  const s = await startWithCard(c, env, dir)
  const view = (await s.call('GET', '/api/admin/storage')).body
  assert.equal(view.card, null, 'nothing chosen')
  assert.deepEqual(view.found.map((f) => [f.volume, f.usable, f.why]), [[VOLUME, true, null]])
  const lines = await runCommand(['card'], { dataDir: dir, port: s.app.ports.http })
  assert.deepEqual(lines, ['Scheda TEST-0001: 30,0 GB liberi su 32,0 GB. Per usarla: node server/index.mjs card use TEST-0001'])
  const track = await s.upload('a.wav', hiWav(300))
  await settle(s.app)
  assert.ok(fs.existsSync(shardPath(dir, 'library', track.id + '.wav')))
  assert.deepEqual(env.st.log, [], 'nothing written on a card only found')
  assert.ok(!fs.existsSync(env.root))
})

test('card: choosing writes .nomedia, then place.json, then source.json; a member is refused', async (t) => {
  const { c, dir, env } = setup(t)
  const s = await startWithCard(c, env, dir)
  const member = device(s.app, { profile: makeProfile(), name: 'Membro' })
  const denied = await member.call('PUT', '/api/admin/storage', { body: { use: VOLUME } })
  assert.equal(denied.status, 403)
  let sourceAtMarker = null
  env.st.onRename = (from, to) => {
    if (path.basename(to) === 'place.json') sourceAtMarker = JSON.parse(fs.readFileSync(path.join(dir, 'source.json'), 'utf8')).card || null
  }
  const view = await useCard(s)
  assert.equal(view.card.volume, VOLUME)
  assert.equal(view.card.state, 'ready')
  const order = env.st.log.filter((l) => /\.nomedia|place\.json/.test(l))
  assert.ok(order[0].endsWith('MPfy/.nomedia'), 'the .nomedia first: ' + order)
  assert.ok(order.some((l) => l.startsWith('rename') && l.endsWith('MPfy/place.json')), 'then the marker, by a rename')
  assert.equal(sourceAtMarker, null, 'source.json names the card only after the marker')
  const card = JSON.parse(fs.readFileSync(path.join(dir, 'source.json'), 'utf8')).card
  const marker = JSON.parse(fs.readFileSync(path.join(env.root, 'place.json'), 'utf8'))
  assert.equal(card.id, marker.id)
  assert.match(marker.id, /^[0-9a-f]{32}$/)
  assert.deepEqual(logLines(dir).filter((l) => l[1] === 'p').pop()[2], { card: marker.id }, 'the log remembers the card')
})

test("card: another source's card is refused card_taken and nothing under it is written", async (t) => {
  const { c, dir, env } = setup(t)
  fs.mkdirSync(env.root)
  fs.writeFileSync(path.join(env.root, 'place.json'), JSON.stringify({ mpfy: 'place', schema: 1, id: 'ab'.repeat(16), source: 'f'.repeat(16), createdAt: 1 }))
  const s = await startWithCard(c, env, dir)
  const view = (await s.call('GET', '/api/admin/storage')).body
  assert.deepEqual(view.found.map((f) => [f.usable, f.why]), [[false, 'other_source']])
  // Asked anyway (a stale page): the marker is read again at the choice.
  const r = await s.call('PUT', '/api/admin/storage', { use: VOLUME })
  assert.equal(r.status, 409)
  assert.equal(r.body.code, 'card_taken')
  assert.deepEqual(env.st.log, [], 'nothing written')
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'source.json'), 'utf8')).card, undefined)
})

test('card: a card whose marker has another id stays away; nothing under it is written or adopted', async (t) => {
  const { c, dir, env } = setup(t)
  let s = await startWithCard(c, env, dir)
  await useCard(s)
  await s.app.close()
  // The same source's marker, another id (another card of this source put in the slot).
  const marker = JSON.parse(fs.readFileSync(path.join(env.root, 'place.json'), 'utf8'))
  fs.writeFileSync(path.join(env.root, 'place.json'), JSON.stringify({ ...marker, id: 'cd'.repeat(16) }))
  const wav = hiWav(777)
  const stray = shardPath(env.root, 'library', 'aa' + '0'.repeat(22) + '.wav')
  fs.mkdirSync(path.dirname(stray), { recursive: true })
  fs.writeFileSync(stray, wav)
  env.st.log.length = 0
  s = await startWithCard(c, env, dir)
  await waitFor(() => s.app.places.card.state === 'away', { what: 'the card away after the grace' })
  assert.equal(s.app.library.tracks.size, 0, 'nothing adopted')
  assert.deepEqual(env.st.log, [], 'nothing written under it')
})

test('card: with its volume folder gone, nothing is ever made above a shard', async (t) => {
  const { c, dir, env } = setup(t)
  const s = await startWithCard(c, env, dir)
  await useCard(s)
  fs.rmSync(env.vol, { recursive: true, force: true })
  const card = s.app.places.card
  card._made.clear()
  await s.app.places.ensureShard(card, 'library', 'ab').catch(() => {})
  await s.app.places.ensureShard(card, 'transcodes', 'cd').catch(() => {})
  assert.ok(!fs.existsSync(env.vol), 'the volume folder is never made again')
  await waitFor(() => card.state === 'away', { what: 'the card away' })
})

test('card: uploads land in internal memory, their jobs read it there, then the move puts them on the card; no tool ever opens a card file', async (t) => {
  const { c, dir, env } = setup(t)
  const s = await startWithCard(c, env, dir)
  await useCard(s)
  const before = s.app.library.version
  const track = await s.upload('a.wav', hiWav(420))
  await settle(s.app)
  const onCard = shardPath(env.root, 'library', track.id + '.wav')
  assert.ok(fs.existsSync(onCard), 'moved onto the card')
  assert.ok(!fs.existsSync(shardPath(dir, 'library', track.id + '.wav')), 'and gone from internal memory')
  assert.ok(treeFiles(dir, 'transcodes').length >= 3, 'its levels made in internal memory')
  assert.ok(s.app.library.version > before)
  // Played from the card, the same bytes.
  const got = await request(s.app.ports.http, 'GET', '/api/stream/' + track.id + '?q=max')
  assert.equal(got.status, 200)
  assert.deepEqual(got.body, fs.readFileSync(onCard))
  // A level made again on demand reads a copy in internal memory.
  fs.unlinkSync(shardPath(dir, 'transcodes', track.id + '.normal.opus'))
  s.app.jobs.forget(track.id, 'normal')
  await request(s.app.ports.http, 'GET', '/api/stream/' + track.id + '?q=normal')
  await settle(s.app)
  assert.ok(fs.existsSync(shardPath(dir, 'transcodes', track.id + '.normal.opus')), 'made again')
  for (const call of s.fake.calls()) assert.ok(!call.args.some((a) => String(a).includes(env.cards)), 'a tool opened a card file: ' + call.args.join(' '))
  assert.equal(env.st.crossRenames, 0, 'no rename from one place to the other was ever tried')
})

test('card: track files and the upload caps stay under FAT32 limit (4 GiB minus one); archives may not, so they stay in internal memory', () => {
  const fat = 4 * GIB - 1
  assert.ok(MAX_UPLOAD_BYTES < fat)
  assert.ok(LIMITS.entryBytes < fat)
  assert.ok(MAX_ARCHIVE_BYTES > fat)
})

test('card: each place its own floor; originals prefer the card, transcodes internal memory; neither: no place', async (t) => {
  const c = cleanup(t)
  const dir = c.dir(tmpDir())
  const env = cardEnv(c, dir)
  const s = await startWithCard(c, env, dir)
  await useCard(s)
  const places = s.app.places
  env.st.cardFree = 1.5 * GIB
  env.st.cardTotal = 32 * GIB // floor: 1 GiB (2% would be less)
  assert.equal((await places.forNew('original', 400 * 1024 ** 2)).kind, 'card')
  assert.equal((await places.forNew('original', 600 * 1024 ** 2)).kind, 'internal', 'over the card floor: internal memory')
  assert.equal((await places.forNew('transcode', 10 * 1024 ** 2)).kind, 'internal', 'a transcode prefers internal memory')
  env.st.internalFree = 2 * GIB // floor: 3 GiB (5% of 60)
  assert.equal((await places.forNew('transcode', 10 * 1024 ** 2)).kind, 'card', 'internal memory at its floor: the card')
  env.st.cardFree = 0.5 * GIB
  assert.equal(await places.forNew('original', 1024), null)
  assert.equal(await places.forNew('transcode', 1024), null)
  // An upload with internal memory under its floor: 507, as before.
  const r = await request(s.app.ports.http, 'PUT', '/api/upload/b.wav', { body: hiWav(510) })
  assert.equal(r.status, 507)
  const h = (await s.call('GET', '/api/health')).body
  assert.equal(typeof h.diskFreeBytes, 'number', 'diskFreeBytes as before')
  assert.deepEqual(h.places.map((p) => p.kind), ['internal', 'card'])
  assert.deepEqual(Object.keys(h.places[1]).sort(), ['awayTracks', 'floorBytes', 'freeBytes', 'kind', 'state', 'totalBytes', 'tracks'])
  assert.equal(h.places[1].floorBytes, GIB)
})

test('card: emulated, self and a folder that is not a mount are never offered, and using one is card_gone', async (t) => {
  const { c, dir, env } = setup(t)
  for (const n of ['emulated', 'self', 'NOTMOUNTED']) fs.mkdirSync(path.join(env.cards, n))
  env.st.sameDev.add('NOTMOUNTED')
  fs.rmSync(env.vol, { recursive: true })
  const s = await startWithCard(c, env, dir)
  assert.deepEqual((await s.call('GET', '/api/admin/storage')).body.found, [])
  for (const v of ['emulated', 'self', 'NOTMOUNTED']) {
    const r = await s.call('PUT', '/api/admin/storage', { use: v })
    assert.equal(r.status, 404, v)
    assert.equal(r.body.code, 'card_gone')
  }
  assert.deepEqual(env.st.log, [])
})

test('card: a malformed card in source.json drops no track of the card at the next start, and the card is away', async (t) => {
  const { c, dir, env } = setup(t)
  let s = await startWithCard(c, env, dir)
  await useCard(s)
  const ids = [(await s.upload('a.wav', hiWav(610))).id, (await s.upload('b.wav', hiWav(620))).id]
  await settle(s.app)
  assert.equal(s.app.library.cardCounts().tracks, 2)
  await s.app.close()
  const src = JSON.parse(fs.readFileSync(path.join(dir, 'source.json'), 'utf8'))
  fs.writeFileSync(path.join(dir, 'source.json'), JSON.stringify({ ...src, card: { ...src.card, volume: 'not a volume!' } }))
  const lines = logLines(dir).length
  s = await startWithCard(c, env, dir)
  assert.deepEqual([...s.app.library.tracks.keys()].sort(), ids.sort(), 'every track kept')
  assert.ok(!logLines(dir).slice(lines).some((l) => l.length === 2 && String(l[1]).startsWith('t:')), 'no tombstone')
  const view = (await s.call('GET', '/api/admin/storage')).body
  assert.equal(view.card.state, 'away', 'the malformed card is a card, away')
  assert.equal(view.card.awayTracks, 2)
})

test('card: source.json lost while a card holds music: the start drops nothing (the log remembers the card)', async (t) => {
  const { c, dir, env } = setup(t)
  let s = await startWithCard(c, env, dir)
  await useCard(s)
  const ids = [(await s.upload('a.wav', hiWav(630))).id]
  await settle(s.app)
  await s.app.close()
  fs.unlinkSync(path.join(dir, 'source.json'))
  const lines = logLines(dir).length
  s = await startWithCard(c, env, dir)
  assert.deepEqual([...s.app.library.tracks.keys()], ids)
  assert.ok(!logLines(dir).slice(lines).some((l) => l.length === 2 && String(l[1]).startsWith('t:')), 'no tombstone')
  const view = (await s.call('GET', '/api/admin/storage')).body
  assert.equal(view.card.state, 'unconfigured')
  // Chosen again: a plain return, nothing adopted, the same track.
  const back = await s.call('PUT', '/api/admin/storage', { use: VOLUME })
  assert.equal(back.status, 200, JSON.stringify(back.body))
  await settle(s.app)
  assert.deepEqual([...s.app.library.tracks.keys()], ids)
  assert.equal(s.app.library.awayIds().length, 0)
})

test('card: export-compat refuses while a card is configured, even away, and moves nothing', async (t) => {
  const { c, dir, env } = setup(t)
  const s = await startWithCard(c, env, dir)
  await useCard(s)
  await s.upload('a.wav', hiWav(640))
  await settle(s.app)
  await s.app.close()
  fs.renameSync(env.vol, env.vol + '-gone')
  const before = treeFiles(dir, 'transcodes')
  await assert.rejects(exportCompat(dir), /Prima riporta la musica nella memoria interna/)
  assert.deepEqual(treeFiles(dir, 'transcodes'), before)
  assert.ok(fs.readdirSync(path.join(dir, 'transcodes')).every((n) => /^[0-9a-f]{2}$/.test(n)), 'still in shards')
})

test('card: a card that hangs takes at most 2 calls, and health, an internal stream and an upload still answer at once', async (t) => {
  const { c, dir, env } = setup(t)
  const s = await startWithCard(c, env, dir, { placesOptions: { callMs: 60000 } })
  await useCard(s)
  const inside = await s.upload('in.wav', hiWav(650))
  s.app.places.card.bad = true // nothing moves onto it meanwhile
  await settle(s.app)
  env.st.hang = true
  const places = s.app.places
  const calls = Array.from({ length: 10 }, (_, i) => places.cardCall(() => env.io.stat(path.join(env.root, 'x' + i))).catch(() => {}))
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.ok(env.st.maxInFlight <= 2 && places.gate.inFlight === 2, 'at most 2 card calls in flight: ' + env.st.maxInFlight + ', ' + places.gate.inFlight)
  assert.ok(places.gate.queue.length >= 8, 'the others wait in JS')
  const t0 = Date.now()
  const h = await s.call('GET', '/api/health')
  assert.equal(h.status, 200)
  const st = await request(s.app.ports.http, 'GET', '/api/stream/' + inside.id + '?q=max')
  assert.equal(st.status, 200)
  assert.ok(Date.now() - t0 < 1000, 'answered at once: ' + (Date.now() - t0) + ' ms')
  void calls
})

test('card: the move copies each original to a .part, syncs it, reads it back from the card, renames it, then deletes the internal copy; no client sees a change', async (t) => {
  const { c, dir, env } = setup(t)
  const s = await startWithCard(c, env, dir)
  const a = await s.upload('a.wav', hiWav(710))
  const b = await s.upload('b.wav', hiWav(720))
  await settle(s.app)
  const v = s.app.library.version
  let internalGoneAt = null
  env.st.onRename = (from, to) => {
    if (to.endsWith(a.id + '.wav') && internalGoneAt === null) internalGoneAt = fs.existsSync(shardPath(dir, 'library', a.id + '.wav'))
  }
  await useCard(s)
  for (const t of [a, b]) {
    const steps = env.st.log.filter((l) => l.includes('mv-') || l.endsWith(t.id + '.wav'))
    const part = steps.find((l) => l.startsWith('open-w') && l.includes('mv-')).split(' ')[1]
    const at = (p) => env.st.log.findIndex(p)
    void part
    assert.ok(env.st.log.some((l) => l.endsWith(t.id + '.wav') && l.startsWith('rename')), 'renamed into its shard')
  }
  const renameA = env.st.log.findIndex((l) => l.startsWith('rename') && l.endsWith(a.id + '.wav'))
  const partA = env.st.log[renameA].split(' ')[1]
  const fsyncA = env.st.log.findIndex((l) => l === 'fsync ' + partA)
  const dropA = env.st.log.findIndex((l) => l === 'drop ' + partA)
  assert.ok(fsyncA !== -1 && fsyncA < renameA, 'synced before its rename')
  assert.ok(dropA !== -1 && dropA > fsyncA && dropA < renameA, 'read back past the cache before its rename')
  assert.equal(internalGoneAt, true, 'the internal copy still there at the rename')
  assert.ok(!fs.existsSync(shardPath(dir, 'library', a.id + '.wav')), 'then deleted')
  assert.equal(s.app.library.version - v <= 1, true, 'the log took only the card line, no track line')
  assert.ok(!logLines(dir).some((l) => l[0] > v && String(l[1]).startsWith('t:')), 'no client delta for a move')
})

test('card: a copy whose bytes are not the track\'s, read from internal memory or back from the card, leaves the original where it was', async (t) => {
  const { c, dir, env } = setup(t)
  const s = await startWithCard(c, env, dir)
  const a = await s.upload('a.wav', hiWav(730))
  await settle(s.app)
  // A bad read of internal memory: the hash of what was read is not the track's.
  env.st.readHook = (file, buf) => (file.includes(a.id) && !file.includes('mv-') && buf.length > 100 ? Buffer.concat([Buffer.from([buf[0] ^ 1]), buf.subarray(1)]) : null)
  await useCard(s)
  assert.ok(fs.existsSync(shardPath(dir, 'library', a.id + '.wav')), 'a bad read: the original stays')
  assert.equal(s.app.library.placeOfTrack(a).kind, 'internal')
  // A card that keeps other bytes than written: read back past the cache, it differs.
  env.st.readHook = (file, buf, dropped) => (dropped && file.includes('mv-') && buf.length > 100 ? Buffer.concat([Buffer.from([buf[0] ^ 1]), buf.subarray(1)]) : null)
  s.app.moves.kick()
  await settle(s.app)
  assert.ok(fs.existsSync(shardPath(dir, 'library', a.id + '.wav')), 'the card did not keep it: the original stays')
  assert.equal(s.app.places.card.bad, true, 'nothing more goes onto that card')
  assert.deepEqual(treeFiles(env.root, 'library'), [])
  const view = (await s.call('GET', '/api/admin/storage')).body
  assert.equal(view.card.bad, true)
})

test('card: `off` brings everything back and ends with no card and no marker; refused without room for the originals, never for the transcodes', async (t) => {
  const { c, dir, env } = setup(t)
  const s = await startWithCard(c, env, dir)
  await useCard(s)
  const a = await s.upload('a.wav', hiWav(740, 3))
  await settle(s.app)
  // A transcode spilled onto the card.
  const key = a.id + '.low'
  const e = s.app.jobs._ready.get(key)
  const spilled = shardPath(env.root, 'transcodes', key + '.opus')
  fs.mkdirSync(path.dirname(spilled), { recursive: true })
  fs.unlinkSync(shardPath(dir, 'transcodes', key + '.opus'))
  fs.writeFileSync(spilled, Buffer.concat([Buffer.from('OggS'), Buffer.alloc(2 * 1024 * 1024)]))
  s.app.jobs._ready.set(key, { ...e, size: 2 * 1024 * 1024 + 4, place: 2 })
  // Internal memory short of the originals: refused, with what is needed.
  const floor = 3 * GIB
  env.st.internalFree = floor + 10
  const refused = await s.call('PUT', '/api/admin/storage', { leave: true })
  assert.equal(refused.status, 507)
  assert.ok(refused.body.needBytes >= floor + a.size, 'needBytes: ' + refused.body.needBytes)
  // Room for the originals, not for the spilled transcode: accepted, the transcode deleted.
  env.st.internalFree = floor + a.size + 1024 * 1024 * 0.5
  const ok = await s.call('PUT', '/api/admin/storage', { leave: true })
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  await settle(s.app)
  await waitFor(() => s.app.places.card === null, { what: 'the card no longer used' })
  assert.ok(fs.existsSync(shardPath(dir, 'library', a.id + '.wav')), 'the original back')
  assert.ok(!fs.existsSync(path.join(env.root, 'place.json')), 'the marker gone')
  assert.ok(!fs.existsSync(env.root), 'the folder gone')
  assert.ok(!fs.existsSync(shardPath(dir, 'transcodes', key + '.opus')), 'the transcode that did not fit was deleted, not brought back')
  assert.equal(s.app.jobs._ready.has(key), false)
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'source.json'), 'utf8')).card ?? null, null)
  assert.equal(logLines(dir).filter((l) => l[1] === 'p').pop().length, 2, 'the log says no card holds music')
})

test('card: the move steps aside for a stream\'s transcode between two files, and waits while a card stream plays', async (t) => {
  const { c, dir, env } = setup(t)
  const s = await startWithCard(c, env, dir)
  const tracks = []
  for (const f of [810, 820, 830]) tracks.push(await s.upload(f + '.wav', hiWav(f)))
  await settle(s.app)
  const jobs = s.app.jobs
  // While a card stream is open the move waits.
  const places = s.app.places
  const fake = places.cardStream(places.internal, shardPath(dir, 'library', tracks[0].id + '.wav'), 0, 10)
  assert.equal(await s.app.moves.step({ signal: new AbortController().signal, current: () => {} }), 'done', 'no card yet')
  await useCard(s, { wait: false })
  assert.equal(await s.app.moves.step({ signal: new AbortController().signal, current: () => {} }), 'wait', 'a card stream plays')
  // Between two files a stream's transcode goes first.
  const order = []
  const run = jobs._runTranscode.bind(jobs)
  jobs._runTranscode = async (job) => {
    order.push('t:' + job.priority)
    return run(job)
  }
  const step = s.app.moves.step.bind(s.app.moves)
  let n = 0
  s.app.moves.step = async (o) => {
    order.push('m')
    if (n++ === 0) {
      fs.unlinkSync(shardPath(dir, 'transcodes', tracks[2].id + '.normal.opus'))
      jobs.forget(tracks[2].id, 'normal')
      jobs.requestTranscode(s.app.library.getTrack(tracks[2].id), 'normal', 0)
    }
    return step(o)
  }
  // The card stream ends: the move goes on after a quiet while.
  fake.destroy()
  await waitFor(() => order.length >= 2, { what: 'the move going on' })
  await settle(s.app)
  assert.equal(order[0], 'm')
  assert.equal(order[1], 't:0', 'the stream\'s transcode right after the first file: ' + order)
})

test('card: a deletion or a replacement while the move copies that track stops the copy; neither track comes back wrong', async (t) => {
  const { c, dir, env } = setup(t)
  const s = await startWithCard(c, env, dir)
  const a = await s.upload('a.wav', hiWav(910, 2))
  const b = await s.upload('b.wav', hiWav(920, 2))
  await settle(s.app)
  // The copy of `a` waits inside its read until the deletion asked for the job to stop.
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let held = false
  env.st.openHook = async (p, flags) => {
    if (!held && p.includes(a.id) && flags === 'r') {
      held = true
      await gate
    }
  }
  await useCard(s, { wait: false })
  await waitFor(() => held, { what: 'the copy of a under way' })
  let answered = false
  const del = s.call('DELETE', '/api/tracks/' + a.id).then((r) => {
    answered = true
    return r
  })
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(answered, false, 'the deletion waits for the copy of its file to stop')
  release()
  assert.equal((await del).status, 200)
  await settle(s.app)
  assert.equal(s.app.library.getTrack(a.id), null)
  assert.ok(!treeFiles(env.root, 'library').includes(a.id + '.wav'), 'no copy of the deleted track on the card')
  assert.ok(!treeFiles(env.root, 'tmp').some((n) => n.startsWith('mv-')), 'its .part gone')
  assert.ok(fs.existsSync(shardPath(env.root, 'library', b.id + '.wav')), 'the other one moved')
  // A file changed under the copy, once all its bytes were copied, by a path that
  // does not stop the job: the commit reads the track again and leaves it as it is now.
  s.app.places.card.bad = true // d stays in internal memory for now
  const d = await s.upload('d.wav', hiWav(930, 2))
  await settle(s.app)
  s.app.places.card.bad = false
  env.st.openHook = null
  const fresh = hiWav(940, 3)
  let changed = false
  env.st.dropHook = (p) => {
    if (changed || !p.includes('mv-')) return
    changed = true
    const tmp = path.join(s.app.library.tmpDir, 'fresh.wav')
    fs.writeFileSync(tmp, fresh)
    s.app.library.replaceFile(d.id, tmp, { size: fresh.length, fileHash: idOf(fresh) }, {})
  }
  s.app.moves.kick()
  await waitFor(() => changed, { what: 'the copy of d done' })
  await settle(s.app)
  env.st.dropHook = null
  const now = s.app.library.getTrack(d.id)
  assert.deepEqual(fs.readFileSync(s.app.library.trackPath(now)), fresh, 'the new bytes are the track, wherever it is')
  await s.app.close()
  const again = await startWithCard(c, env, dir)
  assert.equal(again.app.library.getTrack(a.id), null, 'the deleted track does not come back')
  assert.deepEqual(fs.readFileSync(again.app.library.trackPath(again.app.library.getTrack(d.id))), fresh)
})
