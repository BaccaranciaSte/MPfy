// Comments under the tracks of a source: one per person per track (a second one
// takes the first one's place and keeps its id), 1,000 per track at most, the
// checks of a post, deletion by the author or the owner, who is served what
// (invisible authors, blocks, removed profiles), a track that goes, the ETag, the
// per-minute limit, and the files: one per track, the index of every comment id.

import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createMPfy } from '../server/app.mjs'
import { CommentsStore, MAX_PER_TRACK } from '../server/comments.mjs'
import { tmpDir, cleanup, request, json, makeProfile, makeCard, device, testWhoIs, makeWav, waitFor } from './helpers.mjs'

const MIN = 60 * 1000
const DAY = 24 * 3600 * 1000
const body = (r) => json(r)
const cid = () => crypto.randomBytes(16).toString('hex')

function clock () {
  const c = { t: Date.now(), now: () => c.t, add: (ms) => { c.t += ms } }
  return c
}

async function start (t, opts = {}) {
  const c = cleanup(t)
  const dir = opts.dir || c.dir(tmpDir())
  const app = c.close(await createMPfy({
    dataDir: dir, port: 0, adminPort: 0, p2p: false, debounceMs: 10, ffmpeg: null, fpcalc: null, sevenZip: null, whoIs: testWhoIs, commentsDelayMs: 20, ...opts
  }))
  await app.songsStarted
  return { app, dir, port: app.ports.http }
}

// A person on the source: a device with a profile and its card. The first one
// made with `owner` claims the source.
async function person (app, name, { owner = false } = {}) {
  if (owner) app.people.openClaim(30)
  const profile = makeProfile()
  const d = device(app, { profile })
  const r = await d.call('PUT', '/api/profile/card', { body: makeCard(profile, { name, updatedAt: Date.now() - 1000 }) })
  assert.equal(r.status, 200, r.body.toString())
  return { ...d, id: profile.id, name }
}

async function upload (who, n) {
  const r = await who.call('PUT', '/api/upload/brano' + n + '.wav', { body: makeWav({ seconds: 1, freq: 300 + n * 37, tags: { title: 'Brano ' + n, artist: 'Lumen Marino' } }) })
  assert.equal(r.status, 200, r.body.toString())
  return body(r).track.id
}

const post = (who, fields) => who.call('POST', '/api/comments', { body: { id: cid(), at: Date.now(), ...fields } })
const list = async (who, ids, headers = {}) => {
  const r = await who.call('GET', '/api/comments?tracks=' + ids.join(','), { headers })
  assert.equal(r.status, 200, r.body.toString())
  return body(r).comments
}

async function expectCode (pending, status, code) {
  const r = await pending
  assert.equal(r.status, status, r.body.toString())
  assert.equal(body(r).code, code, r.body.toString())
}

// ------------------------------------------------------------------- posts

test('comments: a post, the same id again, one per person (the first id kept, an older time ignored), the checks', async (t) => {
  const { app } = await start(t)
  const owner = await person(app, 'Bacca', { owner: true })
  const giulia = await person(app, 'Giulia')
  const track = await upload(owner, 1)
  const now = Date.now()

  const id = cid()
  let r = await giulia.call('POST', '/api/comments', { body: { id, trackId: track, at: now - 5000, text: '  che bel\nritornello\t  da cantare ' } })
  assert.equal(r.status, 201, r.body.toString())
  assert.deepEqual(body(r).comment, { id, trackId: track, from: giulia.id, name: 'Giulia', at: now - 5000, text: 'che bel ritornello da cantare' }, 'newlines and tabs become spaces, spaces collapse')

  r = await giulia.call('POST', '/api/comments', { body: { id, trackId: track, at: now - 5000, text: 'che bel ritornello da cantare' } })
  assert.equal(r.status, 200, 'the same id again: 200')
  assert.equal(body(r).comment.id, id)

  // A second comment of hers, newer: it takes the first one's place, with the first id.
  r = await giulia.call('POST', '/api/comments', { body: { id: cid(), trackId: track, at: now - 1000, text: 'anzi, bellissimo' } })
  assert.equal(r.status, 200, r.body.toString())
  assert.deepEqual(body(r).comment, { id, trackId: track, from: giulia.id, name: 'Giulia', at: now - 1000, text: 'anzi, bellissimo' })
  // An older one changes nothing.
  r = await giulia.call('POST', '/api/comments', { body: { id: cid(), trackId: track, at: now - 9000, text: 'vecchio' } })
  assert.equal(body(r).comment.text, 'anzi, bellissimo')
  const mine = await post(owner, { trackId: track, text: 'grazie' })
  assert.equal(mine.status, 201)
  const seen = await list(owner, [track])
  assert.deepEqual(seen.map((c) => [c.from, c.text]), [[owner.id, 'grazie'], [giulia.id, 'anzi, bellissimo']], 'one per person, newest first')

  // The checks.
  await expectCode(giulia.call('POST', '/api/comments', { body: { id: body(mine).comment.id, trackId: track, at: now, text: 'mio' } }), 400, 'bad_comment')
  await expectCode(post(giulia, { trackId: track, text: 'x'.repeat(301) }), 400, 'bad_comment')
  await expectCode(post(giulia, { trackId: track, text: ' \n\t ' }), 400, 'bad_comment')
  await expectCode(post(giulia, { trackId: track, text: 7 }), 400, 'bad_comment')
  await expectCode(post(giulia, { trackId: track, text: 'ciao', extra: 1 }), 400, 'bad_comment')
  await expectCode(post(giulia, { id: 'zz', trackId: track, text: 'ciao' }), 400, 'bad_comment')
  await expectCode(post(giulia, { trackId: track, text: 'ciao', at: Date.now() + 6 * MIN }), 400, 'bad_time')
  await expectCode(post(giulia, { trackId: track, text: 'ciao', at: Date.now() - 31 * DAY }), 400, 'bad_time')
  await expectCode(post(giulia, { trackId: track, text: 'ciao', at: 1.5 }), 400, 'bad_time')
  await expectCode(post(giulia, { trackId: 'f'.repeat(24), text: 'ciao' }), 404, 'version_gone')
  // 300 code points of emoji are fine (code points, never UTF-16 units).
  const other = await person(app, 'Marta')
  r = await post(other, { trackId: track, text: '\u{1F3B6}'.repeat(300) })
  assert.equal(r.status, 201, r.body.toString())
  assert.equal(Array.from(body(r).comment.text).length, 300)
})

test('comments: the 1,001st on a track takes the place of the oldest; the file and the index follow', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  const store = new CommentsStore({ dataDir: dir, writeDelayMs: 5 }).load()
  const track = 'a'.repeat(24)
  const now = Date.now()
  const pids = Array.from({ length: MAX_PER_TRACK + 1 }, (_, i) => crypto.createHash('sha256').update('p' + i).digest('hex').slice(0, 32))
  const first = []
  for (let i = 0; i <= MAX_PER_TRACK; i++) {
    const r = store.post(pids[i], { id: cid(), trackId: track, at: now - DAY + i * 1000, text: 'riga ' + i }, () => true)
    assert.equal(r.created, true)
    first.push(r.comment.id)
  }
  const served = store.list([track], pids[0], () => false)
  assert.equal(served.length, MAX_PER_TRACK)
  assert.equal(served[served.length - 1].text, 'riga 1', 'the oldest (riga 0) went')
  assert.equal(served[0].text, 'riga 1000')
  assert.equal(store.index.get(first[0]), null, 'out of the index too')
  assert.equal(store.size, MAX_PER_TRACK)
  store.close()
  const file = JSON.parse(fs.readFileSync(path.join(dir, 'comments', track + '.json'), 'utf8'))
  assert.equal(file.schema, 1)
  assert.equal(file.comments.length, MAX_PER_TRACK)
  if (process.platform !== 'win32') assert.equal((fs.statSync(path.join(dir, 'comments', track + '.json')).mode & 0o777).toString(8), '600')
  // Read again: the same.
  const again = new CommentsStore({ dataDir: dir }).load()
  assert.equal(again.size, MAX_PER_TRACK)
  assert.equal(again.list([track], pids[5], () => false).length, MAX_PER_TRACK)
  again.close()
})

// --------------------------------------------------------------- deletions

test('comments: the author deletes its own, the owner anyone\'s, a member someone else\'s is 403; unknown 404', async (t) => {
  const { app } = await start(t)
  const owner = await person(app, 'Bacca', { owner: true })
  const giulia = await person(app, 'Giulia')
  const marta = await person(app, 'Marta')
  const track = await upload(owner, 2)
  const g = body(await post(giulia, { trackId: track, text: 'mi piace' })).comment
  const m = body(await post(marta, { trackId: track, text: 'anche a me' })).comment
  const o = body(await post(owner, { trackId: track, text: 'bene' })).comment

  await expectCode(marta.call('DELETE', '/api/comments/' + g.id), 403, 'forbidden')
  await expectCode(marta.call('DELETE', '/api/comments/' + o.id), 403, 'forbidden')
  let r = await marta.call('DELETE', '/api/comments/' + m.id)
  assert.equal(r.status, 200)
  assert.deepEqual(body(r), { ok: true })
  await expectCode(marta.call('DELETE', '/api/comments/' + m.id), 404, 'comment_gone')
  await expectCode(marta.call('DELETE', '/api/comments/' + cid()), 404, 'comment_gone')
  await expectCode(marta.call('DELETE', '/api/comments/zz'), 404, 'comment_gone')
  r = await owner.call('DELETE', '/api/comments/' + g.id)
  assert.equal(r.status, 200, 'the owner moderates')
  assert.deepEqual((await list(giulia, [track])).map((c) => c.id), [o.id])
  // Her place is free again: a new comment of hers is a new one.
  r = await post(giulia, { trackId: track, text: 'di nuovo' })
  assert.equal(r.status, 201)
})

// ------------------------------------------------------------ who sees what

test('comments: an invisible author is hidden from others and shown to itself (kept); a blocked author is hidden from the blocker only', async (t) => {
  const { app } = await start(t)
  const owner = await person(app, 'Bacca', { owner: true })
  const giulia = await person(app, 'Giulia')
  const marta = await person(app, 'Marta')
  const track = await upload(owner, 3)
  await post(giulia, { trackId: track, text: 'invisibile ma presente' })
  await post(marta, { trackId: track, text: 'ciao a tutti' })

  const privacy = (invisible) => ({ privacy: { invisible, showNow: true, privateUntil: 0, showRecent: true, updatedAt: Date.now() } })
  assert.equal((await giulia.call('PUT', '/api/profile/social', { body: privacy(true) })).status, 200)
  assert.deepEqual((await list(owner, [track])).map((c) => c.from), [marta.id], 'hidden from the owner')
  assert.deepEqual((await list(marta, [track])).map((c) => c.from), [marta.id], 'and from a member')
  assert.deepEqual((await list(giulia, [track])).map((c) => c.from).sort(), [giulia.id, marta.id].sort(), 'shown to herself')
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal((await giulia.call('PUT', '/api/profile/social', { body: privacy(false) })).status, 200)
  assert.equal((await list(owner, [track])).length, 2, 'visible again: it was kept')

  // Marta blocks Giulia: Marta no longer sees her comment, the others do.
  const blocked = { blocked: { ids: [giulia.id], updatedAt: Date.now() } }
  assert.equal((await marta.call('PUT', '/api/profile/social', { body: blocked })).status, 200)
  assert.deepEqual((await list(marta, [track])).map((c) => c.from), [marta.id])
  assert.equal((await list(owner, [track])).length, 2)
  assert.equal((await list(giulia, [track])).length, 2, 'the blocked one still sees the blocker')
})

test('comments: a removed profile\'s comments go (served never again, out of the file and the index); a deleted track takes its file', async (t) => {
  const { app, dir } = await start(t)
  const owner = await person(app, 'Bacca', { owner: true })
  const giulia = await person(app, 'Giulia')
  const a = await upload(owner, 4)
  const b = await upload(owner, 5)
  const ga = body(await post(giulia, { trackId: a, text: 'prima' })).comment
  const gb = body(await post(giulia, { trackId: b, text: 'seconda' })).comment
  await post(owner, { trackId: a, text: 'resta' })
  const file = (id) => path.join(dir, 'comments', id + '.json')
  await waitFor(() => fs.existsSync(file(a)) && fs.existsSync(file(b)), { what: 'the files' })

  assert.equal((await owner.call('DELETE', '/api/admin/profiles/' + giulia.id)).status, 200)
  assert.deepEqual((await list(owner, [a, b])).map((c) => c.text), ['resta'])
  await waitFor(() => app.comments.index.get(ga.id) === null && app.comments.index.get(gb.id) === null, { what: 'her ids out of the index' })
  await waitFor(() => !fs.existsSync(file(b)), { what: 'a file with only her comment removed' })
  await waitFor(() => JSON.parse(fs.readFileSync(file(a), 'utf8')).comments.length === 1, { what: 'her comment out of the other file' })

  // The track goes: its comments file and its ids with it.
  assert.equal((await owner.call('DELETE', '/api/tracks/' + a)).status, 200)
  assert.equal(fs.existsSync(file(a)), false)
  assert.equal(app.comments.size, 0)
  assert.deepEqual(await list(owner, [a]), [], 'a track not held: nothing')
})

// ----------------------------------------------------- ETag, limits, routes

test('comments: ETag and 304; 1 to 20 trackIds, ids not held ignored; no profile 403; the 21st write in a minute 429', async (t) => {
  const c = clock()
  const { app, port } = await start(t, { socialNow: c.now })
  const owner = await person(app, 'Bacca', { owner: true })
  const track = await upload(owner, 6)
  await post(owner, { trackId: track, text: 'uno', at: c.now() })
  let r = await owner.call('GET', '/api/comments?tracks=' + track + ',' + 'e'.repeat(24))
  assert.equal(r.status, 200)
  const tag = r.headers.etag
  assert.match(tag, /^"k[0-9a-f]{16}"$/)
  assert.equal(body(r).comments.length, 1, 'an id not held is left out')
  r = await owner.call('GET', '/api/comments?tracks=' + track, { headers: { 'if-none-match': tag } })
  assert.equal(r.status, 304)

  await expectCode(owner.call('GET', '/api/comments'), 400, 'bad_request')
  await expectCode(owner.call('GET', '/api/comments?tracks='), 400, 'bad_request')
  await expectCode(owner.call('GET', '/api/comments?tracks=xyz'), 400, 'bad_request')
  const many = Array.from({ length: 21 }, (_, i) => i.toString(16).padStart(24, '0'))
  await expectCode(owner.call('GET', '/api/comments?tracks=' + many.join(',')), 400, 'bad_request')
  assert.equal((await owner.call('GET', '/api/comments?tracks=' + many.slice(0, 20).join(','))).status, 200)
  for (const [method, p] of [['GET', '/api/comments?tracks=' + track], ['POST', '/api/comments'], ['DELETE', '/api/comments/' + cid()]]) {
    const local = await request(port, method, p, { body: method === 'POST' ? {} : null })
    assert.equal(local.status, 403, method)
    assert.equal(json(local).code, 'no_profile')
  }

  // Twenty writes (posts and deletes) in a minute; the 21st: 429, nothing kept.
  const giulia = await person(app, 'Giulia')
  const ids = []
  for (let i = 0; i < 10; i++) {
    const p = body(await post(giulia, { trackId: track, text: 'prova ' + i, at: c.now() + i })).comment
    ids.push(p.id)
    assert.equal((await giulia.call('DELETE', '/api/comments/' + p.id)).status, 200)
  }
  const late = await post(giulia, { trackId: track, text: 'troppo', at: c.now() + 50 })
  assert.equal(late.status, 429)
  assert.equal(body(late).code, 'slow_down')
  assert.equal(typeof body(late).retryAt, 'number')
  assert.deepEqual((await list(owner, [track])).map((x) => x.text), ['uno'], 'nothing stored')
  c.add(MIN + 1)
  assert.equal((await post(giulia, { trackId: track, text: 'adesso si', at: c.now() })).status, 201)
})

// --------------------------------------------------------------- the files

test('comments: a profile removed while the source was stopped is never served, and its comment leaves the file when the file is read', () => {
  const dir = tmpDir()
  try {
    const track = 'f'.repeat(24)
    const gone = '9'.repeat(32)
    const kept = '8'.repeat(32)
    const first = new CommentsStore({ dataDir: dir, writeDelayMs: 5 }).load()
    first.post(gone, { id: cid(), trackId: track, at: Date.now() - 5, text: 'non ci sono piu' }, () => true)
    first.post(kept, { id: cid(), trackId: track, at: Date.now(), text: 'io resto' }, () => true)
    first.close()
    // The profile was removed by the command line: nothing has swept its comments yet.
    const store = new CommentsStore({ dataDir: dir, isRemoved: (pid) => pid === gone }).load()
    assert.equal(store.size, 2, 'the index still names both')
    assert.deepEqual(store.list([track], kept, () => false).map((c) => c.from), [kept])
    assert.deepEqual(store.list([track], gone, () => false).map((c) => c.from), [kept], 'not even to itself')
    assert.equal(store.size, 1, 'out of the index once its file was read')
    store.close()
    const file = JSON.parse(fs.readFileSync(path.join(dir, 'comments', track + '.json'), 'utf8'))
    assert.deepEqual(file.comments.map((c) => c.from), [kept], 'and out of the file')

    // A track already in memory when a profile goes: hidden at once, before any sweep reaches it.
    const removed = new Set()
    const live = new CommentsStore({ dataDir: dir, isRemoved: (pid) => removed.has(pid) }).load()
    live.post(gone, { id: cid(), trackId: track, at: Date.now(), text: 'di nuovo qui' }, () => true)
    assert.equal(live.list([track], kept, () => false).length, 2)
    removed.add(gone)
    assert.deepEqual(live.list([track], kept, () => false).map((c) => c.from), [kept])
    live.close()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('comments: a restart keeps them; a crash between the index and the file is set right when the file is read', async (t) => {
  const c = cleanup(t)
  const dir = c.dir(tmpDir())
  const track = 'b'.repeat(24)
  const p1 = 'c'.repeat(32)
  const p2 = 'd'.repeat(32)
  const store = new CommentsStore({ dataDir: dir, writeDelayMs: 60000 }).load()
  const kept = store.post(p1, { id: cid(), trackId: track, at: Date.now() - 10, text: 'scritto' }, () => true).comment
  store.flush()
  // A comment in the index whose file write never happened (a crash within the second).
  const lost = store.post(p2, { id: cid(), trackId: track, at: Date.now(), text: 'perso' }, () => true).comment
  store.index.close()
  const lines = fs.readFileSync(path.join(dir, 'comments', 'index.ndjson'), 'utf8').trim().split('\n')
  assert.equal(lines[0], '{"schema":1}')
  assert.equal(lines.length, 3, 'one line per comment')

  const again = new CommentsStore({ dataDir: dir }).load()
  assert.equal(again.size, 2, 'the index knows both')
  assert.deepEqual(again.list([track], p1, () => false).map((x) => x.id), [kept.id], 'the file has only the first')
  assert.equal(again.index.get(lost.id), null, 'the lost one left the index')
  assert.throws(() => again.remove(p2, lost.id, false), (err) => err.code === 'comment_gone')
  again.close()

  // A file the index does not know (an index lost) is read back into it at start.
  fs.unlinkSync(path.join(dir, 'comments', 'index.ndjson'))
  const third = new CommentsStore({ dataDir: dir }).load()
  assert.equal(third.size, 0)
  await third.start((id) => id === track)
  assert.equal(third.size, 1)
  assert.equal(third.index.get(kept.id)[0], track)
  // And the file of a track no longer held goes.
  fs.writeFileSync(path.join(dir, 'comments', 'e'.repeat(24) + '.json'), JSON.stringify({ schema: 1, comments: [{ id: cid(), from: p1, at: 1, text: 'orfano' }] }))
  await third.start((id) => id === track)
  assert.equal(fs.existsSync(path.join(dir, 'comments', 'e'.repeat(24) + '.json')), false)
  third.close()
})
