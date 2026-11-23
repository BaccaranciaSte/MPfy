// The chats of a source: the files (append, reload, a cut last line, seq with
// deletions, the 5,000 and 48 MB trims, the rewrite, memory), a message deleted
// for everyone (its boxes written over where they lie, healed at start, a line
// cut short while written over wiped at start, a file left with no message cut
// down), the API (POST and its checks, the listing with unread and read marks,
// pages, ETag, the long poll), blocks and invisible people in chats, the silent
// group entry, playlists shared in a conversation, and a profile removed (its
// direct conversations go, at start too; nothing is written for it afterwards).

import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import v8 from 'node:v8'
import vm from 'node:vm'
import sodium from 'sodium-native'
import { createMPfy } from '../server/app.mjs'
import {
  ChatStore, directIdOf, groupIdOf, accessBytes, MAX_LIVE, MAX_LIVE_BYTES, MAX_DELETIONS, BODY_BASE, BODY_PER_RECIPIENT
} from '../server/chat.mjs'
import { RATE_LIMITS } from '../server/social.mjs'
import { tmpDir, cleanup, json, makeProfile, makeCard, device, testWhoIs, waitFor } from './helpers.mjs'

v8.setFlagsFromString('--expose-gc')
const gc = vm.runInNewContext('gc')

const MIN = 60 * 1000
const hex16 = () => crypto.randomBytes(16).toString('hex')
// A box as a source sees one: base64 of 24 + 16 + n bytes it cannot open.
const box = (n = 60) => crypto.randomBytes(40 + n).toString('base64')
const body = (r) => json(r)

function clock () {
  const c = { t: Date.now(), now: () => c.t, add: (ms) => { c.t += ms } }
  return c
}

async function start (t, opts = {}) {
  const c = cleanup(t)
  const dir = opts.dir || c.dir(tmpDir())
  const app = c.close(await createMPfy({
    dataDir: dir, port: 0, adminPort: 0, p2p: false, debounceMs: 10, ffmpeg: null, fpcalc: null, sevenZip: null, whoIs: testWhoIs, ...opts
  }))
  return { app, dir, port: app.ports.http }
}

async function person (app, name, { card = true } = {}) {
  const profile = makeProfile()
  const d = device(app, { profile })
  if (card) {
    const r = await d.call('PUT', '/api/profile/card', { body: makeCard(profile, { name, updatedAt: Date.now() - 1000 }) })
    assert.equal(r.status, 200, r.body.toString())
  } else {
    assert.equal((await d.call('GET', '/api/profile')).status, 200)
  }
  return { ...d, profile, id: profile.id, name }
}

async function expectCode (pending, status, code) {
  const r = await pending
  assert.equal(r.status, status, r.body.toString())
  assert.equal(body(r).code, code, r.body.toString())
  return body(r)
}

const privacy = (fields) => ({ invisible: false, showNow: true, privateUntil: 0, showRecent: true, updatedAt: Date.now(), ...fields })

// A message from `who` to the conversation `cid`: one box per profile named.
function send (who, cid, { to = [], id = hex16(), at = Date.now(), with: w, boxes = null, playlist } = {}) {
  const b = boxes || Object.fromEntries([who.id, ...to.map((x) => x.id || x)].map((p) => [p, box()]))
  const payload = { id, at, boxes: b }
  if (w !== undefined) payload.with = w.id || w
  if (playlist !== undefined) payload.playlist = playlist
  return who.call('POST', '/api/chat/' + cid + '/messages', { body: payload })
}

const dm = (a, b) => directIdOf(a.id, b.id)
const convs = async (who) => body(await who.call('GET', '/api/chat/conversations')).conversations
const convOf = async (who, cid) => (await convs(who)).find((c) => c.id === cid)
const messages = async (who, cid, q = '') => body(await who.call('GET', '/api/chat/' + cid + '/messages' + q))
const listed = async (who) => body(await who.call('GET', '/api/people')).people

// A store on its own, without fsync (thousands of messages).
function store (t, dir, groupId = groupIdOf('22'.repeat(32))) {
  const s = new ChatStore({ dataDir: dir, groupId, sync: false })
  t.after(() => s.close())
  return s
}

const A = '0a'.repeat(16)
const B = '0b'.repeat(16)
const DAB = directIdOf(A, B)
const put = (s, { id = hex16(), from = A, at = Date.now(), boxes = [box(), box()], pl = null } = {}) =>
  s.post(DAB, 'direct', A, B, from, { id, at, pl, to: from === A ? [A, B] : [B, A], boxes })

// ------------------------------------------------------------------ ids

test('ids: the direct id of A and B and the group id of 32 x 0x22 are the vectors', () => {
  assert.equal(directIdOf('22de25661c578b57b919dfcada067bd4', '0b2b8f2b813476f9b1bea832400198fe'), 'ab25e6e72ec668e6e39fbbb7ff239a74')
  assert.equal(directIdOf('0b2b8f2b813476f9b1bea832400198fe', '22de25661c578b57b919dfcada067bd4'), 'ab25e6e72ec668e6e39fbbb7ff239a74')
  assert.equal(groupIdOf('22'.repeat(32)), 'cac44b906c75b7bce7fd9f8b78224c35')
})

// --------------------------------------------------------------- storage

test('storage: appended and read back after a restart; seq counts messages and deletions; a cut last line is dropped and the file cut back', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  let s = store(t, dir)
  await s.load()
  const ids = [hex16(), hex16(), hex16()]
  const boxesOf = new Map()
  for (const [i, id] of ids.entries()) {
    const boxes = [box(10 + i), box(20 + i)]
    boxesOf.set(id, boxes)
    const r = await put(s, { id, from: i === 1 ? B : A, boxes })
    assert.equal(r.entry.seq, i + 1)
  }
  const conv = s.get(DAB)
  await s.remove(conv, A, ids[0])
  await s.read(conv, B, { at: 5, id: ids[2] })
  assert.equal(conv.seq, 4)
  const file = path.join(dir, 'chat', DAB + '.ndjson')
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  assert.deepEqual(JSON.parse(lines[0]), { h: { v: 1, kind: 'direct', a: A, b: B } })
  assert.deepEqual(JSON.parse(lines[4]), { d: { id: ids[0], seq: 4 } })
  assert.deepEqual(JSON.parse(lines[5]), { r: { p: B, at: 5, id: ids[2] } })
  assert.deepEqual(Object.keys(JSON.parse(lines[1]).m), ['id', 'seq', 'from', 'at', 'boxes'])
  await s.close()

  // A crash in the middle of a line.
  fs.appendFileSync(file, '{"m":{"id":"' + hex16() + '","seq":5,"fr')
  s = store(t, dir)
  await s.load()
  assert.ok(fs.readFileSync(file, 'utf8').endsWith('}}\n'), 'cut back to the last whole line')
  const again = s.get(DAB)
  assert.equal(again.seq, 4)
  assert.deepEqual(again.entries.map((e) => [e.k, e.id, e.seq]), [['m', ids[1], 2], ['m', ids[2], 3], ['d', ids[0], 4]])
  assert.deepEqual(again.reads.get(B), { at: 5, id: ids[2] })
  // Each box read alone, by its offset, is the one written.
  const forB = await s.readBoxes(again, again.entries, B)
  assert.equal(forB.get(ids[1]), boxesOf.get(ids[1])[0], 'B wrote it: its box comes first')
  assert.equal(forB.get(ids[2]), boxesOf.get(ids[2])[1])
  assert.equal(forB.has(ids[0]), false, 'a deleted message has no box')
  const r = await put(s, { from: A })
  assert.equal(r.entry.seq, 5, 'seq goes on from the file')
})

test('storage: trims at 5,000 live messages and at 48 MB (the oldest go); the rewrite keeps each read mark, the live messages and the newest 1,000 deletions', { timeout: 180000 }, async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  const s = store(t, dir)
  await s.load()
  const first = []
  for (let i = 0; i < MAX_LIVE + 10; i++) {
    const r = await put(s, { from: i % 2 === 0 ? A : B, boxes: [box(8), box(8)] })
    if (i < 10) first.push(r.entry.id)
  }
  const conv = s.get(DAB)
  assert.equal(MAX_LIVE, 5000)
  assert.equal(conv.live, 5000)
  for (const id of first) assert.equal(conv.byId.has(id), false, 'the oldest went')
  // At the limit every message trims one: the file is not rewritten every few of them,
  // only once what it holds of no use weighs a quarter of the live part (and 1 MB).
  const rewrites = s.compactions
  for (let i = 0; i < 300; i++) await put(s, { from: i % 2 === 0 ? A : B, boxes: [box(8), box(8)] })
  assert.equal(conv.live, 5000)
  assert.equal(s.compactions, rewrites, 'no rewrite for 310 small messages trimmed')
  // 1,200 deletions: the newest 1,000 kept.
  const live = conv.entries.filter((e) => e.k === 'm')
  for (let i = 0; i < 1200; i++) await s.remove(conv, live[i].from, live[i].id)
  assert.equal(MAX_DELETIONS, 1000)
  assert.equal(conv.deletions, 1000)
  assert.equal(conv.byId.has(live[0].id), false, 'an old deletion is forgotten')
  assert.equal(conv.byId.get(live[1199].id).k, 'd')
  await s.read(conv, A, { at: 1, id: live[2000].id })
  await s.read(conv, A, { at: 2, id: live[2001].id })
  await s.read(conv, B, { at: 3, id: live[2002].id })
  // Read marks until the file is rewritten (more than twice its live lines plus 1,000).
  const before = s.compactions
  let n = 0
  while (s.compactions === before && n < 20000) await s.read(conv, A, { at: 10 + n++, id: live[3000].id })
  assert.equal(s.compactions, before + 1)
  assert.ok(n >= 2 * (1 + 2 + 3800 + 1000) + 1000 - 3 * 5010, 'not before it is due: ' + n)
  await s.close()
  const lines = fs.readFileSync(path.join(dir, 'chat', DAB + '.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(lines.filter((l) => l.r).length, 2, 'one read mark per profile')
  assert.equal(lines.find((l) => l.r && l.r.p === B).r.at, 3)
  const blank = (l) => Object.values(l.m.boxes).every((x) => x === '')
  assert.equal(lines.filter((l) => l.m && !blank(l)).length, 3800)
  // Each kept deletion comes with its message, blank, so it is read back after a restart.
  assert.equal(lines.filter((l) => l.m && blank(l)).length, 1000)
  assert.equal(lines.filter((l) => l.d).length, 1000)
  const seqs = lines.filter((l) => l.m || l.d).map((l) => (l.m || l.d).seq)
  assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y), 'in seq order')
  const again = store(t, dir)
  await again.load()
  const c2 = again.get(DAB)
  assert.equal(c2.live, 3800)
  assert.equal(c2.deletions, 1000, 'the deletions are still there after a restart')
  assert.equal(c2.seq, conv.seq, 'seq never goes back')
  assert.deepEqual(c2.entries.filter((e) => e.k === 'd').map((e) => [e.id, e.seq, e.msg.from, e.msg.at]), conv.entries.filter((e) => e.k === 'd').map((e) => [e.id, e.seq, e.msg.from, e.msg.at]))
  const boxes = await again.readBoxes(c2, c2.entries.filter((e) => e.k === 'm').slice(-3), A)
  assert.equal(boxes.size, 3)

  // 48 MB: big boxes, the oldest go before the 5,000.
  const dir2 = cleanup(t).dir(tmpDir())
  const big = store(t, dir2)
  await big.load()
  const bigBox = () => crypto.randomBytes(12000).toString('base64')
  // About 32 KB a line: past 48 MB at about 1,570, a rewrite once 12 MB of it are trimmed
  // (at about 1,950).
  for (let i = 0; i < 2000; i++) await put(big, { boxes: [bigBox(), bigBox()] })
  const cb = big.get(DAB)
  assert.equal(MAX_LIVE_BYTES, 48 * 1024 * 1024)
  assert.ok(cb.liveBytes <= MAX_LIVE_BYTES && cb.liveBytes > MAX_LIVE_BYTES - 64 * 1024, 'up to 48 MB: ' + cb.liveBytes)
  assert.ok(cb.live < 1600)
  assert.equal(big.compactions, 1)
  // What was trimmed leaves the disk at that rewrite: never more than a quarter on top.
  const size = fs.statSync(path.join(dir2, 'chat', DAB + '.ndjson')).size
  assert.ok(size <= MAX_LIVE_BYTES * 1.25 + 32200, 'file ' + size)
})

test('storage: a 5,000 message conversation adds less than 2 MB of heap (the boxes stay on disk); a line written another way is still served', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  const s = store(t, dir)
  await s.load()
  for (let i = 0; i < 5000; i++) await put(s, { from: i % 2 === 0 ? A : B, boxes: [box(200), box(200)] })
  await s.close()
  gc()
  gc()
  const before = process.memoryUsage().heapUsed
  const again = new ChatStore({ dataDir: dir, groupId: groupIdOf('22'.repeat(32)), sync: false })
  await again.load()
  gc()
  gc()
  const grew = process.memoryUsage().heapUsed - before
  assert.equal(again.get(DAB).live, 5000)
  assert.ok(grew < 2 * 1024 * 1024, 'heap grew by ' + grew)
  await again.close()

  // A line with spaces and its keys in another order: read whole, served all the same.
  const dir2 = cleanup(t).dir(tmpDir())
  fs.mkdirSync(path.join(dir2, 'chat'))
  const id = hex16()
  const bA = box()
  const bB = box()
  fs.writeFileSync(path.join(dir2, 'chat', DAB + '.ndjson'),
    JSON.stringify({ h: { v: 1, kind: 'direct', a: A, b: B } }) + '\n' +
    JSON.stringify({ m: { boxes: { [B]: bB, [A]: bA }, at: 7, from: A, seq: 1, id } }, null, 1).replace(/\n/g, ' ') + '\n')
  const odd = store(t, dir2)
  await odd.load()
  const c = odd.get(DAB)
  assert.equal(c.entries[0].raw, true)
  assert.equal((await odd.readBoxes(c, c.entries, A)).get(id), bA)
  assert.equal((await odd.readBoxes(c, c.entries, B)).get(id), bB)
  // A file without a header is set aside.
  const dir3 = cleanup(t).dir(tmpDir())
  fs.mkdirSync(path.join(dir3, 'chat'))
  fs.writeFileSync(path.join(dir3, 'chat', DAB + '.ndjson'), '{"m":{}}\n')
  const broken = store(t, dir3)
  await broken.load()
  assert.equal(broken.get(DAB), null)
  assert.ok(fs.readdirSync(path.join(dir3, 'chat')).some((n) => n.startsWith(DAB + '.ndjson.corrupt-')))
})

test('storage: a read during a rewrite gets the right box', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  const s = store(t, dir)
  await s.load()
  const sent = []
  for (let i = 0; i < 300; i++) {
    const boxes = [box(30), box(30)]
    const r = await put(s, { boxes })
    sent.push([r.entry, boxes[0]])
  }
  const conv = s.get(DAB)
  // Read marks until a rewrite is due, with reads of every box running meanwhile.
  const reads = []
  let rewrites = s.compactions
  for (let i = 0; i < 2 * 303 + 1100; i++) {
    const p = s.read(conv, A, { at: i + 1, id: sent[0][0].id })
    if (i % 50 === 0) reads.push(s.readBoxes(conv, sent.map(([e]) => e), A))
    await p
  }
  await waitFor(() => s.compactions > rewrites, { what: 'the rewrite' })
  rewrites = s.compactions
  for (const got of await Promise.all(reads)) {
    for (const [e, b] of sent) assert.equal(got.get(e.id), b)
  }
  const after = await s.readBoxes(conv, sent.map(([e]) => e), A)
  for (const [e, b] of sent) assert.equal(after.get(e.id), b)
})

// ---------------------------------------------------- deleted for everyone

const HEAL_LINES = 64

// Whether any 16 characters in a row of `s` are anywhere in `bytes`.
function holdsAny (bytes, s) {
  for (let k = 0; k + 16 <= s.length; k += 8) if (bytes.includes(s.slice(k, k + 16), 0, 'latin1')) return true
  return false
}

const chatFile = (dir, cid) => path.join(dir, 'chat', cid + '.ndjson')

test('deleted for everyone: once the deletion is on disk its boxes and its playlist are written over where they lie, the line keeping its length; every other byte stays where it was and is served, before and after a restart', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  const s = store(t, dir)
  await s.load()
  const sent = []
  for (let i = 0; i < 4; i++) {
    const boxes = [box(30 + i), box(50 + i)]
    const r = await put(s, { from: i % 2 === 0 ? A : B, boxes, pl: i === 1 ? 'fedcba9876543210' : null })
    sent.push({ e: r.entry, boxes })
  }
  const conv = s.get(DAB)
  const file = chatFile(dir, DAB)
  const before = fs.readFileSync(file)
  const gone = sent[1]
  const { off, len } = gone.e
  await s.remove(conv, B, gone.e.id)
  const after = fs.readFileSync(file)
  for (const b of gone.boxes) assert.equal(holdsAny(after, b), false, 'a box of the deleted message is still in the file')
  assert.equal(after.includes('fedcba9876543210', 0, 'latin1'), false, 'the playlist it shared is still in the file')
  // What stays of it: its id, seq, sender, time and the profiles it was for; then spaces.
  const line = after.subarray(off, off + len)
  assert.equal(line[len - 1], 0x0a)
  assert.deepEqual(JSON.parse(line.toString('latin1')), { m: { id: gone.e.id, seq: 2, from: B, at: gone.e.at, boxes: { [B]: '', [A]: '' } } })
  assert.match(line.toString('latin1'), /^\{"m":\{[^ ]*\}\}\} +\n$/)
  // Every other byte where it was, the deletion line after them.
  assert.ok(before.subarray(0, off).equals(after.subarray(0, off)))
  assert.ok(before.subarray(off + len).equals(after.subarray(off + len, before.length)))
  assert.equal(after.subarray(before.length).toString('latin1'), '{"d":{"id":"' + gone.e.id + '","seq":5}}\n')
  const check = async (st) => {
    const c = st.get(DAB)
    const forA = await st.readBoxes(c, c.entries, A)
    const forB = await st.readBoxes(c, c.entries, B)
    assert.equal(forA.has(gone.e.id), false)
    assert.equal(forB.has(gone.e.id), false)
    for (const x of [sent[0], sent[2], sent[3]]) {
      const k = x.e.from === A ? 0 : 1
      assert.equal(forA.get(x.e.id), x.boxes[k])
      assert.equal(forB.get(x.e.id), x.boxes[1 - k])
    }
    // The deletion is still served as itself, to the same people.
    const d = c.byId.get(gone.e.id)
    assert.deepEqual([d.k, d.seq, d.msg.from, d.msg.at, [...d.msg.to]], ['d', 5, B, gone.e.at, [B, A]])
    assert.equal(c.seq, 5)
  }
  await check(s)
  await s.close()
  const again = store(t, dir)
  const blank = again._blank
  let blanked = 0
  again._blank = function (c, list) {
    blanked += list.length
    return blank.call(this, c, list)
  }
  await again.load()
  await check(again)
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(blanked, 0, 'nothing left to blank at the next start')
  assert.equal((await put(again, {})).entry.seq, 6)
})

test('deleted for everyone: a deletion on disk whose boxes are still there (a crash in between, or a version before this one) is blanked at the next start, in the background and in small batches', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  let s = store(t, dir)
  await s.load()
  const sent = []
  for (let i = 0; i < 160; i++) {
    const boxes = [box(20), box(20)]
    sent.push({ e: (await put(s, { boxes })).entry, boxes })
  }
  await s.close()
  // The deletion lines alone, as a crash right after them leaves the file (and as
  // earlier versions left every deletion): 150 of the 160.
  const file = chatFile(dir, DAB)
  fs.appendFileSync(file, sent.slice(0, 150).map((x, i) => '{"d":{"id":"' + x.e.id + '","seq":' + (161 + i) + '}}\n').join(''))
  const size = fs.statSync(file).size
  const batches = []
  s = store(t, dir)
  const blank = s._blank
  s._blank = function (c, list) {
    batches.push(list.length)
    return blank.call(this, c, list)
  }
  await s.load()
  const conv = s.get(DAB)
  assert.equal(conv.live, 10)
  assert.equal(conv.deletions, 150)
  const clean = () => {
    const bytes = fs.readFileSync(file)
    return sent.slice(0, 150).every((x) => !holdsAny(bytes, x.boxes[0]) && !holdsAny(bytes, x.boxes[1]))
  }
  await waitFor(clean, { timeout: 5000, what: 'the deleted boxes gone from the file' })
  assert.equal(fs.statSync(file).size, size, 'written over in place, nothing rewritten')
  assert.equal(s.compactions, 0)
  assert.ok(batches.length >= Math.ceil(150 / HEAL_LINES) && batches.every((n) => n <= HEAL_LINES), 'batches ' + batches)
  // The live ones are untouched and served.
  const forA = await s.readBoxes(conv, conv.entries, A)
  for (const x of sent.slice(150)) assert.equal(forA.get(x.e.id), x.boxes[0])
  // A message written meanwhile lands as usual.
  assert.equal((await put(s, {})).entry.seq, 311)
  await s.close()
  const again = store(t, dir)
  await again.load()
  assert.equal(again.get(DAB).deletions, 150)
  assert.equal(again.get(DAB).seq, 311)
})

test('deleted for everyone: a message line a crash cut short while it was written over keeps nothing of its boxes after the next start, in place', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  let s = store(t, dir)
  await s.load()
  const keepBoxes = [box(), box()]
  const keep = await put(s, { boxes: keepBoxes })
  const goneBoxes = [box(3000), box(3000)]
  const gone = (await put(s, { boxes: goneBoxes })).entry
  const next = await put(s, {})
  await s.close()
  // The deletion on disk, then its blank written only part way (the first 2,000
  // bytes of the line): the rest of its boxes still there, the line no JSON.
  const file = chatFile(dir, DAB)
  fs.appendFileSync(file, '{"d":{"id":"' + gone.id + '","seq":4}}\n')
  const part = Buffer.alloc(2000, 0x20)
  part.write('{"m":{"id":"' + gone.id + '","seq":2,"from":"' + A + '","at":' + gone.at + ',"boxes":{"' + A + '":"","' + B + '":""}}}', 0, 'latin1')
  const fd = fs.openSync(file, 'r+')
  fs.writeSync(fd, part, 0, part.length, gone.off)
  fs.closeSync(fd)
  const size = fs.statSync(file).size
  assert.ok(holdsAny(fs.readFileSync(file), goneBoxes[1]))
  s = store(t, dir)
  await s.load()
  const conv = s.get(DAB)
  assert.deepEqual([conv.seq, conv.live], [4, 2])
  await waitFor(() => {
    const bytes = fs.readFileSync(file)
    return !holdsAny(bytes, goneBoxes[0].slice(1900)) && !holdsAny(bytes, goneBoxes[1])
  }, { timeout: 5000, what: 'what was left of the boxes gone from the file' })
  assert.equal(fs.statSync(file).size, size)
  assert.equal(s.compactions, 0)
  const line = fs.readFileSync(file).subarray(gone.off, gone.off + gone.len)
  assert.match(line.toString('latin1'), /^ +\n$/, 'spaces only')
  const forA = await s.readBoxes(conv, conv.entries, A)
  assert.equal(forA.get(keep.entry.id), keepBoxes[0])
  assert.ok(forA.has(next.entry.id))
  assert.equal((await put(s, {})).entry.seq, 5)
})

test('storage: a file an earlier version rewrote (deletions kept without their messages) goes on from the newest seq in it, never back', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  fs.mkdirSync(path.join(dir, 'chat'))
  const id = hex16()
  fs.writeFileSync(chatFile(dir, DAB),
    JSON.stringify({ h: { v: 1, kind: 'direct', a: A, b: B } }) + '\n' +
    '{"m":{"id":"' + id + '","seq":1,"from":"' + A + '","at":5,"boxes":{"' + A + '":"' + box() + '","' + B + '":"' + box() + '"}}}\n' +
    '{"d":{"id":"' + hex16() + '","seq":4}}\n')
  const s = store(t, dir)
  await s.load()
  const conv = s.get(DAB)
  assert.deepEqual([conv.seq, conv.live, conv.deletions], [4, 1, 0])
  // A core that read up to 4 before that rewrite still gets what comes next.
  assert.equal((await put(s, {})).entry.seq, 5)
})

test('deleted for everyone: a read under way when the message is deleted never serves what is left of its line', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  const s = store(t, dir)
  await s.load()
  const keepBoxes = [box(), box()]
  const keep = await put(s, { boxes: keepBoxes })
  const gone = await put(s, {})
  const conv = s.get(DAB)
  // The read opens the file only once the deletion went through.
  const open = fs.promises.open
  t.after(() => { fs.promises.open = open })
  let go = null
  const held = new Promise((resolve) => { go = resolve })
  fs.promises.open = async (...args) => {
    await held
    return open.apply(fs.promises, args)
  }
  const reading = s.readBoxes(conv, [keep.entry, gone.entry], A)
  fs.promises.open = open
  await s.remove(conv, A, gone.entry.id)
  go()
  const got = await reading
  assert.equal(got.get(keep.entry.id), keepBoxes[0])
  assert.equal(got.has(gone.entry.id), false)
})

test('storage: kept deletions weighing over 1 MB on their own (a group of 30) never make a rewrite at every write', { timeout: 120000 }, async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  const s = store(t, dir)
  await s.load()
  const people = Array.from({ length: 30 }, (_, i) => (i + 16).toString(16).padStart(2, '0').repeat(16))
  const write = () => s.post(s.groupId, 'group', null, null, people[0], { id: hex16(), at: Date.now(), pl: null, to: people, boxes: people.map(() => box(1)) })
  const sent = []
  for (let i = 0; i < 1010; i++) sent.push((await write()).entry)
  const conv = s.get(s.groupId)
  for (let i = 0; i < 1000; i++) await s.remove(conv, people[0], sent[i].id)
  assert.equal(conv.deletions, 1000)
  assert.ok(conv.delBytes > 1024 * 1024, 'kept deletions ' + conv.delBytes)
  const rewrites = s.compactions
  for (let i = 0; i < 20; i++) await write()
  assert.ok(s.compactions - rewrites <= 1, 'rewrites for 20 messages: ' + (s.compactions - rewrites))
})

test('a conversation left with no message is cut down at once to what it keeps, not rewritten at every delete; its seq, the pages after any seq, the ETag and the long poll stay right, after a restart too', async (t) => {
  const c = clock()
  const { app, dir } = await start(t, { socialNow: c.now })
  const a = await person(app, 'Anna')
  const b = await person(app, 'Bruno')
  const group = app.chat.groupId
  const sent = []
  for (let i = 0; i < 3; i++) {
    c.add(1000)
    sent.push(body(await send(a, group, { to: [b], at: c.now() })).message)
  }
  // Bruno holds everything up to seq 3.
  assert.deepEqual((await messages(b, group, '?after=0')).messages.map((m) => m.seq), [1, 2, 3])
  for (const m of sent.slice(0, 2)) assert.equal((await a.call('DELETE', '/api/chat/' + group + '/messages/' + m.id)).status, 200)
  const tag = (await b.call('GET', '/api/chat/conversations')).headers.etag
  const waiting = b.call('GET', '/api/chat/conversations?wait=10', { headers: { 'if-none-match': tag } })
  await waitFor(() => app.chat._waiters.has(b.id), { what: 'Bruno waiting' })
  const rewrites = app.chat.compactions
  assert.equal((await a.call('DELETE', '/api/chat/' + group + '/messages/' + sent[2].id)).status, 200)
  const woke = await waiting
  assert.equal(woke.status, 200)
  assert.equal(app.chat.compactions, rewrites + 1, 'cut down at once')
  const file = chatFile(dir, group)
  const text = fs.readFileSync(file, 'latin1')
  assert.ok(!text.includes('  '), 'no blank space left')
  const lines = text.trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(lines.map((l) => Object.keys(l)[0] + ((l.m || l.d || {}).seq || '')), ['h', 'm1', 'm2', 'm3', 'd4', 'd5', 'd6'])
  for (const l of lines.filter((x) => x.m)) assert.deepEqual(Object.values(l.m.boxes), ['', ''])
  // What a core holding seq 3, or nothing, is told.
  const dels = sent.map((m, i) => ({ id: m.id, seq: 4 + i, from: a.id, at: m.at, deleted: true }))
  assert.deepEqual((await messages(b, group, '?after=3')).messages, dels)
  assert.deepEqual((await messages(b, group, '?after=0')).messages, dels)
  assert.deepEqual((await messages(b, group, '?before=7')).messages, dels)
  const conv = await convOf(b, group)
  assert.deepEqual([conv.seq, conv.last, conv.unread], [6, null, 0])
  const tag2 = woke.headers.etag
  assert.equal((await b.call('GET', '/api/chat/conversations', { headers: { 'if-none-match': tag2 } })).status, 304)

  // A direct one the same way.
  const ab = dm(a, b)
  const two = []
  for (let i = 0; i < 2; i++) {
    c.add(1000)
    two.push(body(await send(a, ab, { with: b, to: [b], at: c.now() })).message)
  }
  for (const m of two) await a.call('DELETE', '/api/chat/' + ab + '/messages/' + m.id)
  assert.ok(!fs.readFileSync(chatFile(dir, ab), 'latin1').includes('  '))
  assert.deepEqual((await messages(b, ab, '?after=2')).messages.map((m) => [m.seq, m.deleted]), [[3, true], [4, true]])

  // Emptied again and again: not a rewrite at every delete.
  const before = app.chat.compactions
  for (let i = 0; i < 10; i++) {
    c.add(1000)
    const m = body(await send(a, group, { to: [b], at: c.now() })).message
    await a.call('DELETE', '/api/chat/' + group + '/messages/' + m.id)
  }
  assert.ok(app.chat.compactions - before <= 4, 'rewrites: ' + (app.chat.compactions - before))
  assert.equal(app.chat.get(group).seq, 26)

  // After a restart: the same seq, the same answers, the same ETag.
  const head = (await messages(b, group, '?after=0')).messages
  const tag4 = (await b.call('GET', '/api/chat/conversations')).headers.etag
  await app.close()
  const app2 = (await start(t, { dir, socialNow: c.now })).app
  const a2 = { ...a.on(app2), id: a.id }
  const b2 = { ...b.on(app2), id: b.id }
  assert.equal((await b2.call('GET', '/api/chat/conversations', { headers: { 'if-none-match': tag4 } })).status, 304)
  assert.deepEqual((await messages(b2, group, '?after=0')).messages, head)
  assert.deepEqual((await messages(b2, group, '?after=3')).messages.slice(0, 3), dels)
  assert.deepEqual((await messages(b2, ab, '?after=2')).messages.map((m) => [m.seq, m.deleted]), [[3, true], [4, true]])
  c.add(1000)
  assert.equal(body(await send(a2, group, { to: [b], at: c.now() })).message.seq, 27)
  assert.equal(body(await send(a2, ab, { with: b, to: [b], at: c.now() })).message.seq, 5)
})

// -------------------------------------------------------------------- POST

test('POST: idempotent by id; another sender\'s id refused; the sender\'s own box required; the direct id must match; with someone invisible who never wrote: 404; boxes of others dropped; the 61st write in a minute 429', async (t) => {
  const c = clock()
  const { app } = await start(t, { socialNow: c.now })
  const a = await person(app, 'Anna')
  const b = await person(app, 'Bruno')
  const x = await person(app, 'Carla')
  const ab = dm(a, b)
  const id = hex16()
  const boxes = { [a.id]: box(), [b.id]: box(), [x.id]: box() }
  let r = await send(a, ab, { id, with: b, boxes, at: c.now() })
  assert.equal(r.status, 201, r.body.toString())
  const msg = body(r).message
  assert.deepEqual(msg, { id, seq: 1, from: a.id, at: c.now(), box: boxes[a.id] })
  // The same id again from the same sender: the stored one, nothing changed.
  r = await send(a, ab, { id, with: b, boxes: { [a.id]: box(), [b.id]: box() }, at: c.now() })
  assert.equal(r.status, 200)
  assert.deepEqual(body(r).message, msg)
  assert.equal(app.chat.get(ab).seq, 1)
  // Someone else with that id.
  await expectCode(send(b, ab, { id, with: a, at: c.now() }), 400, 'bad_message')
  // The third box went: Carla never gets this one.
  assert.deepEqual(app.chat.get(ab).entries[0].to, [a.id, b.id])
  assert.deepEqual((await messages(b, ab)).messages.map((m) => m.box), [boxes[b.id]])
  assert.equal((await convOf(x, ab)), undefined)

  await expectCode(send(a, ab, { with: b, boxes: { [b.id]: box() }, at: c.now() }), 400, 'bad_message')
  await expectCode(send(a, dm(a, x), { with: b, at: c.now() }), 400, 'bad_message')
  await expectCode(send(a, ab, { at: c.now() }), 400, 'bad_message')
  await expectCode(send(a, ab, { with: a, at: c.now() }), 400, 'bad_message')
  await expectCode(send(a, ab, { with: b, at: c.now(), boxes: { [a.id]: 'not base64', [b.id]: box() } }), 400, 'bad_message')
  await expectCode(send(a, ab, { with: b, at: c.now(), boxes: { [a.id]: crypto.randomBytes(40).toString('base64'), [b.id]: box() } }), 400, 'bad_message')
  await expectCode(send(a, ab, { with: b, at: c.now(), boxes: { [a.id]: crypto.randomBytes(12329).toString('base64'), [b.id]: box() } }), 400, 'bad_message')
  await expectCode(send(a, ab, { with: b, at: c.now() + 6 * MIN }), 400, 'bad_time')
  await expectCode(send(a, ab, { with: b, at: c.now() - 31 * 24 * 60 * MIN }), 400, 'bad_time')
  await expectCode(send(a, ab, { with: b, at: 1.5 }), 400, 'bad_time')
  await expectCode(a.call('POST', '/api/chat/' + ab + '/messages', { body: { id: hex16(), at: c.now(), with: b.id, boxes: { [a.id]: box() }, extra: 1 } }), 400, 'bad_message')

  // Someone invisible who never wrote to the caller: no direct conversation with them.
  c.add(MIN)
  await x.call('PUT', '/api/profile/social', { body: { privacy: privacy({ invisible: true, updatedAt: c.now() }) } })
  await expectCode(send(a, dm(a, x), { with: x, to: [x], at: c.now() }), 404, 'no_person')
  // They write first: then the caller may answer.
  assert.equal((await send(x, dm(a, x), { with: a, to: [a], at: c.now() })).status, 201)
  assert.equal((await send(a, dm(a, x), { with: x, to: [x], at: c.now() })).status, 201)
  const nobody = makeProfile()
  await expectCode(send(a, dm(a, { id: nobody.id }), { with: nobody.id, at: c.now() }), 404, 'no_person')

  // 60 chat writes a minute (messages, deletions, read marks), the 61st 429.
  c.add(MIN)
  assert.equal(RATE_LIMITS.chat, 60)
  let last = null
  for (let i = 0; i < 59; i++) assert.equal((await send(a, ab, { with: b, to: [b], at: c.now() })).status, 201)
  last = await a.call('PUT', '/api/chat/' + ab + '/read', { body: { at: c.now(), id: hex16() } })
  assert.equal(last.status, 200)
  const refused = await expectCode(send(a, ab, { with: b, to: [b], at: c.now() }), 429, 'slow_down')
  assert.ok(refused.retryAt > c.now())
  const head = app.chat.get(ab).seq
  c.add(MIN)
  assert.equal((await send(a, ab, { with: b, to: [b], at: c.now() })).status, 201)
  assert.equal(app.chat.get(ab).seq, head + 1, 'the refused one was not stored')
})

test('POST: a body one byte over 4 KB plus 16.5 KB per recipient is 413, in a direct conversation and in a group of 150', { timeout: 120000 }, async (t) => {
  const c = clock()
  const { app } = await start(t, { socialNow: c.now })
  const a = await person(app, 'Anna')
  const b = await person(app, 'Bruno')
  assert.equal(BODY_BASE, 4096)
  assert.equal(BODY_PER_RECIPIENT, 16896)
  // A body padded with spaces to an exact size (JSON allows them).
  const sized = (payload, size) => {
    const text = JSON.stringify(payload)
    return text.slice(0, -1) + ' '.repeat(size - Buffer.byteLength(text)) + '}'
  }
  const raw = (who, cid, text) => who.call('POST', '/api/chat/' + cid + '/messages', { body: Buffer.from(text), headers: { 'content-type': 'application/json' } })
  const ab = dm(a, b)
  const limit = BODY_BASE + 2 * BODY_PER_RECIPIENT
  const payload = { id: hex16(), at: c.now(), with: b.id, boxes: { [a.id]: box(), [b.id]: box() } }
  assert.equal((await raw(a, ab, sized(payload, limit + 1))).status, 413)
  assert.equal((await raw(a, ab, sized(payload, limit))).status, 201)

  // A group of 150: the limit grows with it.
  const people = [a, b]
  for (let i = 0; i < 148; i++) {
    const p = makeProfile()
    app.profiles.create(p.id, p.signPublicKey.toString('hex'))
    app.social.putCard(p.id, makeCard(p, { name: 'Persona ' + i, updatedAt: Date.now() - 1000 }))
    people.push({ id: p.id })
  }
  const group = app.chat.groupId
  assert.equal(body(await a.call('GET', '/api/chat/group')).recipients.length, 150)
  const glimit = BODY_BASE + 150 * BODY_PER_RECIPIENT
  const gp = { id: hex16(), at: c.now(), boxes: Object.fromEntries(people.map((p) => [p.id, box()])) }
  assert.equal((await raw(a, group, sized(gp, glimit + 1))).status, 413)
  const ok = await raw(a, group, sized(gp, glimit))
  assert.equal(ok.status, 201, ok.body.toString())
  assert.equal(app.chat.get(group).entries[0].to.length, 150)
})

// ------------------------------------------------------------------ listing

test('listing: the group always there; unread leaves out own, deleted and hidden messages; read marks only for their profile; after, before and more; ETag and 304', async (t) => {
  const c = clock()
  const { app } = await start(t, { socialNow: c.now })
  const a = await person(app, 'Anna')
  const b = await person(app, 'Bruno')
  const x = await person(app, 'Carla')
  const group = app.chat.groupId
  let list = await convs(a)
  assert.deepEqual(list, [{ id: group, kind: 'group', seq: 0, last: null, unread: 0, read: null }], 'the group before any message')
  assert.deepEqual(body(await a.call('GET', '/api/chat/conversations')).group, group)

  const ab = dm(a, b)
  const sent = []
  for (let i = 0; i < 5; i++) {
    c.add(1000)
    const who = i % 2 === 0 ? b : a
    const r = await send(who, ab, { with: who === a ? b : a, to: [who === a ? b : a], at: c.now() })
    sent.push(body(r).message)
  }
  // B wrote 0, 2, 4; A wrote 1, 3.
  let conv = await convOf(a, ab)
  assert.equal(conv.kind, 'direct')
  assert.equal(conv.with, b.id)
  assert.equal(conv.unread, 3, 'own messages are not unread')
  assert.equal(conv.seq, 5)
  assert.equal(conv.last.id, sent[4].id)
  assert.ok(typeof conv.last.box === 'string')
  assert.equal(conv.read, null)
  assert.equal((await convOf(x, ab)), undefined, 'not in someone else\'s list')

  assert.deepEqual(body(await b.call('DELETE', '/api/chat/' + ab + '/messages/' + sent[2].id)), { ok: true })
  assert.deepEqual(body(await b.call('DELETE', '/api/chat/' + ab + '/messages/' + sent[2].id)), { ok: true }, 'again: the same')
  await expectCode(a.call('DELETE', '/api/chat/' + ab + '/messages/' + sent[0].id), 403, 'forbidden')
  await expectCode(a.call('DELETE', '/api/chat/' + ab + '/messages/' + hex16()), 404, 'message_gone')
  conv = await convOf(a, ab)
  assert.equal(conv.unread, 2, 'a deleted message is not unread')
  assert.equal(conv.seq, 6)

  // A read mark: kept when later, served to its own profile only.
  let r = await a.call('PUT', '/api/chat/' + ab + '/read', { body: { at: sent[0].at, id: sent[0].id } })
  assert.deepEqual(body(r), { read: { at: sent[0].at, id: sent[0].id } })
  r = await a.call('PUT', '/api/chat/' + ab + '/read', { body: { at: sent[0].at - 1, id: sent[1].id } })
  assert.deepEqual(body(r), { read: { at: sent[0].at, id: sent[0].id } }, 'an earlier mark is not kept')
  conv = await convOf(a, ab)
  assert.equal(conv.unread, 1)
  assert.deepEqual(conv.read, { at: sent[0].at, id: sent[0].id })
  assert.equal((await convOf(b, ab)).read, null, 'never served to the other profile')
  await expectCode(a.call('PUT', '/api/chat/' + ab + '/read', { body: { at: c.now() + 6 * MIN, id: hex16() } }), 400, 'bad_time')
  await expectCode(a.call('PUT', '/api/chat/' + ab + '/read', { body: { at: 5 } }), 400, 'bad_request')
  await expectCode(x.call('PUT', '/api/chat/' + ab + '/read', { body: { at: 5, id: hex16() } }), 404, 'message_gone')

  // Pages: after, before, more; a deletion comes as itself.
  let page = await messages(a, ab, '?after=0&limit=2')
  assert.deepEqual(page.messages.map((m) => m.seq), [1, 2])
  assert.equal(page.more, true)
  assert.equal(page.seq, 6)
  page = await messages(a, ab, '?after=2')
  assert.deepEqual(page.messages.map((m) => [m.seq, m.deleted === true]), [[4, false], [5, false], [6, true]])
  assert.deepEqual(page.messages[2], { id: sent[2].id, seq: 6, from: b.id, at: sent[2].at, deleted: true })
  assert.equal(page.more, false)
  page = await messages(a, ab, '?before=5&limit=2')
  assert.deepEqual(page.messages.map((m) => m.seq), [2, 4])
  assert.equal(page.more, true)
  page = await messages(a, ab, '?before=2')
  assert.deepEqual(page.messages.map((m) => m.seq), [1])
  assert.equal(page.more, false)
  page = await messages(a, ab, '?after=0&limit=5000')
  assert.equal(page.messages.length, 5)
  for (const q of ['?after=x', '?limit=0', '?after=1&before=3', '?before=-1']) await expectCode(a.call('GET', '/api/chat/' + ab + '/messages' + q), 400, 'bad_request')
  assert.deepEqual(await messages(x, ab), { time: c.now(), seq: 0, messages: [], more: false }, 'nothing for someone else')

  // ETag: unchanged is a 304, a change is not.
  r = await a.call('GET', '/api/chat/conversations')
  const tag = r.headers.etag
  assert.match(tag, /^"c[0-9a-f]{16}"$/)
  assert.equal((await a.call('GET', '/api/chat/conversations', { headers: { 'if-none-match': tag } })).status, 304)
  c.add(1000)
  await send(b, ab, { with: a, to: [a], at: c.now() })
  r = await a.call('GET', '/api/chat/conversations', { headers: { 'if-none-match': tag } })
  assert.equal(r.status, 200)
  assert.notEqual(r.headers.etag, tag)
  list = body(r).conversations
  assert.equal(list.length, 2)
})

test('long poll: with wait and the ETag of what it has, the answer waits for a change; a message wakes it at once; nothing changed is a 304 after the wait', async (t) => {
  const { app } = await start(t)
  const a = await person(app, 'Anna')
  const b = await person(app, 'Bruno')
  const r0 = await a.call('GET', '/api/chat/conversations')
  const tag = r0.headers.etag
  // Nothing changes: a 304 after the wait (1 s).
  let started = Date.now()
  let r = await a.call('GET', '/api/chat/conversations?wait=1', { headers: { 'if-none-match': tag } })
  assert.equal(r.status, 304)
  assert.ok(Date.now() - started >= 900, 'it waited')
  // A message to A while it waits: the answer comes then, with it.
  started = Date.now()
  const waiting = a.call('GET', '/api/chat/conversations?wait=20', { headers: { 'if-none-match': tag } })
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal((await send(b, dm(a, b), { with: a, to: [a] })).status, 201)
  r = await waiting
  assert.equal(r.status, 200)
  assert.ok(Date.now() - started < 5000, 'woken by the message')
  assert.equal(body(r).conversations.find((x) => x.kind === 'direct').unread, 1)
  // A change that is not A's does not answer A.
  const x = await person(app, 'Carla')
  const tag2 = r.headers.etag
  started = Date.now()
  const quiet = a.call('GET', '/api/chat/conversations?wait=2', { headers: { 'if-none-match': tag2 } })
  await send(b, dm(b, x), { with: x, to: [x] })
  assert.equal((await quiet).status, 304)
  assert.ok(Date.now() - started >= 1800)
  // Without the ETag (or with another one), at once.
  started = Date.now()
  assert.equal((await a.call('GET', '/api/chat/conversations?wait=20')).status, 200)
  assert.equal((await a.call('GET', '/api/chat/conversations?wait=20', { headers: { 'if-none-match': '"cother"' } })).status, 200)
  assert.ok(Date.now() - started < 2000)
  await expectCode(a.call('GET', '/api/chat/conversations?wait=x'), 400, 'bad_request')
  // Closing the source answers whoever waits.
  const held = a.call('GET', '/api/chat/conversations?wait=20', { headers: { 'if-none-match': (await a.call('GET', '/api/chat/conversations')).headers.etag } }).catch(() => null)
  await new Promise((resolve) => setTimeout(resolve, 200))
  started = Date.now()
  await app.close()
  await held
  assert.ok(Date.now() - started < 5000)
})

test('long poll: a profile holds 8 waits at most; the oldest beyond them answers at once and never waits again', async (t) => {
  const { app } = await start(t)
  const a = await person(app, 'Anna')
  const tag = (await a.call('GET', '/api/chat/conversations')).headers.etag
  const started = Date.now()
  const held = []
  for (let i = 0; i < 8; i++) held.push(a.call('GET', '/api/chat/conversations?wait=3', { headers: { 'if-none-match': tag } }).then((r) => ({ r, ms: Date.now() - started })))
  await new Promise((resolve) => setTimeout(resolve, 300))
  const ninth = await a.call('GET', '/api/chat/conversations?wait=3', { headers: { 'if-none-match': tag } })
  assert.equal(ninth.status, 304)
  const first = await Promise.race(held)
  assert.equal(first.r.status, 304)
  assert.ok(first.ms < 1500, 'the oldest answered when the ninth came: ' + first.ms)
  const rest = await Promise.all(held)
  assert.equal(rest.filter((x) => x.ms >= 2500).length, 7, 'the other seven waited their time')
})

test('summaries: counted from where they stopped as messages come, the same as counting again from the start', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  const s = store(t, dir)
  await s.load()
  const hidden = () => false
  const check = (what) => {
    const conv = s.get(DAB)
    for (const pid of [A, B]) {
      const kept = s.summary(conv, pid, hidden, 0)
      conv.cache.delete(pid)
      assert.deepEqual(s.summary(conv, pid, hidden, 0), kept, what + ' (' + pid.slice(0, 2) + ')')
    }
  }
  const sent = []
  for (let i = 0; i < 30; i++) {
    sent.push((await put(s, { from: i % 3 === 0 ? A : B, at: Date.now() - (i % 5) * 1000 })).entry)
    if (i % 7 === 0) check('after ' + i)
    s.summary(s.get(DAB), A, hidden, 0)
    s.summary(s.get(DAB), B, hidden, 0)
  }
  check('appended')
  await s.read(s.get(DAB), A, { at: sent[10].at, id: sent[10].id })
  check('a read mark')
  const after = []
  for (let i = 0; i < 5; i++) after.push((await put(s, { from: B })).entry)
  check('appended after the mark')
  const before = s.summary(s.get(DAB), A, hidden, 0)
  assert.equal(before.last.id, after[4].id)
  // The newest message, unread by A, deleted: both its count and the last change.
  await s.remove(s.get(DAB), B, after[4].id)
  const now = s.summary(s.get(DAB), A, hidden, 0)
  assert.equal(now.unread, before.unread - 1)
  assert.equal(now.last.id, after[3].id)
  check('a deletion')
  assert.ok(now.unread > 0)
})

// ------------------------------------------------------------------- blocks

test('blocks: a message to a blocker keeps only the sender\'s box and answers 201; a blocked sender\'s group messages are hidden and come back after the unblock; the blocked one\'s direct conversation is not in the list', async (t) => {
  const c = clock()
  const { app } = await start(t, { socialNow: c.now })
  const a = await person(app, 'Anna')
  const b = await person(app, 'Bruno')
  const x = await person(app, 'Carla')
  const ab = dm(a, b)
  assert.equal((await send(b, ab, { with: a, to: [a], at: c.now() })).status, 201)
  c.add(MIN)
  await a.call('PUT', '/api/profile/social', { body: { blocked: { ids: [b.id], updatedAt: c.now() } } })
  const r = await send(b, ab, { with: a, to: [a], at: c.now() })
  assert.equal(r.status, 201, 'to B it looks sent')
  const conv = app.chat.get(ab)
  assert.deepEqual(conv.entries[1].to, [b.id], 'only the sender\'s own box')
  assert.equal((await convOf(a, ab)), undefined, 'not in the blocker\'s list')
  assert.ok(await convOf(b, ab), 'still in B\'s')

  const group = app.chat.groupId
  const everyone = [a, b, x]
  c.add(1000)
  await send(b, group, { to: everyone, at: c.now() })
  c.add(1000)
  await send(x, group, { to: everyone, at: c.now() })
  let ga = await convOf(a, group)
  assert.equal(ga.unread, 1, 'B\'s group message hidden from A')
  assert.equal(ga.last.from, x.id)
  assert.deepEqual((await messages(a, group)).messages.map((m) => m.from), [x.id])
  assert.equal((await convOf(x, group)).unread, 1, 'X still sees it')
  c.add(MIN)
  await a.call('PUT', '/api/profile/social', { body: { blocked: { ids: [], updatedAt: c.now() } } })
  ga = await convOf(a, group)
  assert.equal(ga.unread, 2, 'shown again after the unblock')
  assert.deepEqual((await messages(a, group)).messages.map((m) => m.from), [b.id, x.id])
  // The direct message sent while blocked never had A's box: it stays unseen.
  assert.equal((await convOf(a, ab)).unread, 1)
})

// ---------------------------------------------------------------- invisible

test('invisible: listed as chat after writing, only to the right people; a group writer seen by every member; not a group recipient until writing there or turning visible; every recipient in every member\'s people', async (t) => {
  const c = clock()
  const { app } = await start(t, { socialNow: c.now })
  const a = await person(app, 'Anna')
  const b = await person(app, 'Bruno')
  const x = await person(app, 'Carla')
  const group = app.chat.groupId
  const recipients = async () => body(await a.call('GET', '/api/chat/group')).recipients
  assert.deepEqual(await recipients(), [a.id, b.id, x.id].sort())
  c.add(MIN)
  await x.call('PUT', '/api/profile/social', { body: { privacy: privacy({ invisible: true, updatedAt: c.now() }) } })
  assert.ok(!(await listed(a)).some((p) => p.profileId === x.id), 'invisible: absent')
  assert.deepEqual(await recipients(), [a.id, b.id].sort(), 'not a group recipient while invisible and silent')

  // X writes to A only: A lists X as "chat", B does not.
  assert.equal((await send(x, dm(a, x), { with: a, to: [a], at: c.now() })).status, 201)
  const seenByA = (await listed(a)).find((p) => p.profileId === x.id)
  assert.deepEqual(seenByA, { profileId: x.id, card: app.social.card(x.id), seen: 'chat', now: null, last: null })
  assert.ok(!(await listed(b)).some((p) => p.profileId === x.id))
  await expectCode(a.call('GET', '/api/people/' + x.id), 404, 'no_person')
  assert.notEqual((await a.call('GET', '/api/people/' + x.id + '/photo')).status, 403)
  // That message deleted: no longer listed.
  const xm = (await messages(x, dm(a, x))).messages[0]
  await x.call('DELETE', '/api/chat/' + dm(a, x) + '/messages/' + xm.id)
  assert.ok(!(await listed(a)).some((p) => p.profileId === x.id))

  // X writes in the group: every member lists X as "chat", and X is a recipient again.
  assert.equal((await send(x, group, { to: [a, b], at: c.now() })).status, 201)
  for (const who of [a, b]) assert.equal((await listed(who)).find((p) => p.profileId === x.id).seen, 'chat')
  assert.deepEqual(await recipients(), [a.id, b.id, x.id].sort())
  // Every recipient is in every member's list.
  for (const who of [a, b, x]) {
    const ids = new Set((await listed(who)).map((p) => p.profileId))
    for (const pid of await recipients()) if (pid !== who.id) assert.ok(ids.has(pid), who.name + ' lists ' + pid)
  }

  // Y never wrote: a recipient again only when visible.
  const y = await person(app, 'Dario')
  c.add(MIN)
  await y.call('PUT', '/api/profile/social', { body: { privacy: privacy({ invisible: true, updatedAt: c.now() }) } })
  assert.ok(!(await recipients()).includes(y.id))
  c.add(MIN)
  await y.call('PUT', '/api/profile/social', { body: { privacy: privacy({ invisible: false, updatedAt: c.now() }) } })
  assert.ok((await recipients()).includes(y.id))
})

// --------------------------------------------------------- the silent entry

test('the silent group entry: signed with the card\'s key, it counts as having written; a wrong signature or no card refused; it goes with the profile', async (t) => {
  const c = clock()
  const { app } = await start(t, { socialNow: c.now })
  const a = await person(app, 'Anna')
  const x = await person(app, 'Carla')
  const group = app.chat.groupId
  const sign = (p, at, gid = group) => {
    const sig = Buffer.alloc(64)
    sodium.crypto_sign_detached(sig, accessBytes(p.id, gid, at), p.profile.signSecretKey)
    return sig.toString('hex')
  }
  assert.equal(accessBytes(x.id, group, 5).toString(), 'mpfy/chat-access/1[1,"' + x.id + '","' + group + '",5]')
  assert.equal(body(await x.call('GET', '/api/profile')).social.access, 0)
  const at = c.now()
  let r = await x.call('PUT', '/api/chat/group/access', { body: { at, sig: sign(x, at) } })
  assert.equal(r.status, 200, r.body.toString())
  assert.deepEqual(body(r), { access: { at } })
  assert.equal(body(await x.call('GET', '/api/profile')).social.access, at)
  // An older one keeps the newer.
  assert.deepEqual(body(await x.call('PUT', '/api/chat/group/access', { body: { at: at - 5, sig: sign(x, at - 5) } })), { access: { at } })
  await expectCode(x.call('PUT', '/api/chat/group/access', { body: { at, sig: sign(x, at + 1) } }), 400, 'bad_card')
  await expectCode(x.call('PUT', '/api/chat/group/access', { body: { at, sig: sign(x, at, '00'.repeat(16)) } }), 400, 'bad_card')
  await expectCode(x.call('PUT', '/api/chat/group/access', { body: { at: c.now() + 6 * MIN, sig: sign(x, c.now() + 6 * MIN) } }), 400, 'bad_time')
  await expectCode(x.call('PUT', '/api/chat/group/access', { body: { at } }), 400, 'bad_request')
  const nocard = await person(app, 'Senza', { card: false })
  await expectCode(nocard.call('PUT', '/api/chat/group/access', { body: { at, sig: sign(nocard, at) } }), 400, 'bad_card')
  // Nothing to show: no message, no unread, no change of seq.
  assert.deepEqual(await convOf(a, group), { id: group, kind: 'group', seq: 0, last: null, unread: 0, read: null })

  // Invisible with the entry: still a recipient, listed as "chat" to every member.
  c.add(MIN)
  await x.call('PUT', '/api/profile/social', { body: { privacy: privacy({ invisible: true, updatedAt: c.now() }) } })
  assert.ok(body(await a.call('GET', '/api/chat/group')).recipients.includes(x.id))
  assert.equal((await listed(a)).find((p) => p.profileId === x.id).seen, 'chat')
  // Kept across a restart.
  const dir = app.chat.dir
  assert.ok(fs.readFileSync(path.join(dir, group + '.ndjson'), 'utf8').includes('"a":{"p":"' + x.id + '"'))

  // The profile removed: its entry goes.
  app.people.removeProfile(x.id)
  assert.equal(app.chat.accessAt(x.id), 0)
  assert.ok(!body(await a.call('GET', '/api/chat/group')).recipients.includes(x.id))
})

// ------------------------------------------------------------- playlists

test('a playlist shared in a conversation: served to the people of the message as its sender keeps it now, read only, until the message is deleted', async (t) => {
  const { app } = await start(t)
  const a = await person(app, 'Anna')
  const b = await person(app, 'Bruno')
  const x = await person(app, 'Carla')
  const created = body(await a.call('POST', '/api/playlists', { body: { name: 'Per sabato' } })).playlist
  const T = (n) => n.toString(16).padStart(24, '0')
  await a.call('PATCH', '/api/playlists/' + created.id, { body: { trackIds: [T(1), T(2)] } })
  const ab = dm(a, b)
  let r = await send(a, ab, { with: b, to: [b], playlist: created.id })
  assert.equal(r.status, 201, r.body.toString())
  const id = body(r).message.id
  const url = '/api/chat/' + ab + '/messages/' + id + '/playlist'
  r = await b.call('GET', url)
  assert.equal(r.status, 200, r.body.toString())
  assert.deepEqual(body(r).playlist.trackIds, [T(1), T(2)])
  assert.equal(body(r).playlist.name, 'Per sabato')
  // Current: a change on the sender's side shows at the next read; an unchanged one is a 304.
  const tag = r.headers.etag
  assert.equal((await b.call('GET', url, { headers: { 'if-none-match': tag } })).status, 304)
  await a.call('PATCH', '/api/playlists/' + created.id, { body: { trackIds: [T(2), T(3), T(4)] } })
  r = await b.call('GET', url, { headers: { 'if-none-match': tag } })
  assert.equal(r.status, 200)
  assert.deepEqual(body(r).playlist.trackIds, [T(2), T(3), T(4)])
  await expectCode(x.call('GET', url), 404, 'message_gone')
  // Someone else's playlist id is never served through a message.
  const theirs = body(await x.call('POST', '/api/playlists', { body: { name: 'Mia' } })).playlist
  r = await send(a, ab, { with: b, to: [b], playlist: theirs.id })
  assert.equal((await b.call('GET', '/api/chat/' + ab + '/messages/' + body(r).message.id + '/playlist')).status, 404)
  // Deleted: no longer served.
  await a.call('DELETE', '/api/chat/' + ab + '/messages/' + id)
  await expectCode(b.call('GET', url), 404, 'message_gone')
})

// -------------------------------------------------------------- removal

test('a removed profile: in the group its read marks go, its messages stay (the deleted ones blanked), it is no longer a recipient; its direct conversations go with their files and leave the other person\'s list at once', async (t) => {
  const { app, dir } = await start(t)
  const a = await person(app, 'Anna')
  const b = await person(app, 'Bruno')
  const x = await person(app, 'Carla')
  const group = app.chat.groupId
  await send(b, group, { to: [a, x] })
  const m = (await messages(a, group)).messages[0]
  await b.call('PUT', '/api/chat/' + group + '/read', { body: { at: m.at, id: m.id } })
  assert.ok(app.chat.get(group).reads.has(b.id))
  const delBoxes = { [b.id]: box(), [a.id]: box(), [x.id]: box() }
  const del = body(await send(b, group, { boxes: delBoxes })).message
  assert.equal((await b.call('DELETE', '/api/chat/' + group + '/messages/' + del.id)).status, 200)
  // Bruno's direct conversations, and one without him.
  const ab = dm(a, b)
  const bx = dm(b, x)
  const ax = dm(a, x)
  await send(a, ab, { with: b, to: [b] })
  await send(b, ab, { with: a, to: [a] })
  await send(x, bx, { with: b, to: [b] })
  await send(a, ax, { with: x, to: [x] })
  assert.ok((await convs(a)).some((c) => c.id === ab))
  // Anna waits on what she has: the removal answers her at once.
  const tag = (await a.call('GET', '/api/chat/conversations')).headers.etag
  const waiting = a.call('GET', '/api/chat/conversations?wait=10', { headers: { 'if-none-match': tag } })
  await waitFor(() => app.chat._waiters.has(a.id), { what: 'Anna waiting' })
  const started = Date.now()
  app.people.removeProfile(b.id)
  const r = await waiting
  assert.equal(r.status, 200)
  assert.ok(Date.now() - started < 5000)
  assert.deepEqual(body(r).conversations.map((c) => c.id).sort(), [group, ax].sort())
  assert.equal(app.chat.get(ab), null)
  assert.equal(app.chat.get(bx), null)
  await waitFor(() => !fs.existsSync(chatFile(dir, ab)) && !fs.existsSync(chatFile(dir, bx)), { what: 'the files of its direct conversations gone' })
  assert.ok(fs.existsSync(chatFile(dir, ax)))
  assert.deepEqual((await messages(a, ab)).messages, [])
  assert.deepEqual((await convs(x)).map((c) => c.id).sort(), [group, ax].sort())
  // The group.
  assert.equal(app.chat.get(group).reads.has(b.id), false)
  assert.deepEqual((await messages(a, group)).messages.map((y) => [y.id, y.deleted === true]), [[m.id, false], [del.id, true]], 'its messages stay')
  const bytes = fs.readFileSync(chatFile(dir, group))
  for (const v of Object.values(delBoxes)) assert.equal(holdsAny(bytes, v), false)
  assert.deepEqual(body(await a.call('GET', '/api/chat/group')).recipients.sort(), [a.id, x.id].sort())
})

test('a removed profile, in the store: its direct conversations go from memory at once and their people\'s waits end, then their files; nothing is written there again', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  const s = store(t, dir)
  await s.load()
  const first = (await put(s, {})).entry
  const second = (await put(s, {})).entry
  const C = '0c'.repeat(16)
  const DBC = directIdOf(B, C)
  await s.post(DBC, 'direct', B, C, C, { id: hex16(), at: Date.now(), pl: null, to: [C, B], boxes: [box(), box()] })
  const conv = s.get(DAB)
  // A delete already queued, and one asked after: refused, nothing is written there again.
  const queued = s.remove(conv, A, first.id)
  const waitA = s.waitFor(A, 5000)
  const waitC = s.waitFor(C, 5000)
  const started = Date.now()
  const removed = s.removeProfile(B)
  assert.equal(s.get(DAB), null)
  assert.equal(s.get(DBC), null)
  assert.equal(await waitA, 'change')
  assert.equal(await waitC, 'change')
  assert.ok(Date.now() - started < 2000)
  await assert.rejects(queued, (err) => err.code === 'message_gone')
  await assert.rejects(s.remove(conv, A, second.id), (err) => err.code === 'message_gone')
  await removed
  assert.equal(fs.existsSync(chatFile(dir, DAB)), false)
  assert.equal(fs.existsSync(chatFile(dir, DBC)), false)
  assert.deepEqual(s.conversationsOf(A, () => false).map((x) => x.id), [s.groupId])
})

test('a removed profile: a write it had under way when it was removed lands nowhere, and its direct file is not made again', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  const removed = new Set()
  const s = new ChatStore({ dataDir: dir, groupId: groupIdOf('22'.repeat(32)), sync: false, isRemoved: (pid) => removed.has(pid) })
  t.after(() => s.close())
  await s.load()
  await put(s, {})
  removed.add(B)
  await s.removeProfile(B)
  // Its own message to Anna, a message to it, its read mark, its silent entry, a group message.
  await assert.rejects(put(s, { from: B }), (err) => err.code === 'no_person')
  await assert.rejects(put(s, { from: A }), (err) => err.code === 'no_person')
  await assert.rejects(s.access(B, { at: 1, sig: 'ab'.repeat(64) }), (err) => err.code === 'no_person')
  await assert.rejects(s.post(s.groupId, 'group', null, null, B, { id: hex16(), at: Date.now(), pl: null, to: [B, A], boxes: [box(), box()] }), (err) => err.code === 'no_person')
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(s.get(DAB), null)
  assert.equal(fs.existsSync(chatFile(dir, DAB)), false)
  assert.deepEqual(s.conversationsOf(A, () => false).map((x) => x.id), [s.groupId])
  assert.equal(s.get(s.groupId), null, 'nothing written in the group either')
  // The source passes it its profiles.
  const { app } = await start(t)
  const a = await person(app, 'Anna')
  const x = await person(app, 'Carla')
  await send(x, dm(a, x), { with: a, to: [a] })
  const g = app.chat.groupId
  const m = body(await send(a, g, { to: [x] })).message
  app.people.removeProfile(x.id)
  await assert.rejects(app.chat.post(dm(a, x), 'direct', a.id < x.id ? a.id : x.id, a.id < x.id ? x.id : a.id, x.id, { id: hex16(), at: Date.now(), pl: null, to: [x.id, a.id], boxes: [box(), box()] }), (err) => err.code === 'no_person')
  await assert.rejects(app.chat.read(app.chat.get(g), x.id, { at: m.at, id: m.id }), (err) => err.code === 'no_person')
  assert.equal(app.chat.get(dm(a, x)), null)
})

test('at start: a direct conversation with someone removed before goes with its file, and the deleted records an earlier version left with their boxes are blanked', async (t) => {
  const { app, dir } = await start(t)
  const a = await person(app, 'Anna')
  const x = await person(app, 'Carla')
  const group = app.chat.groupId
  const ax = dm(a, x)
  await send(x, ax, { with: a, to: [a] })
  await send(a, ax, { with: x, to: [x] })
  const xBoxes = { [x.id]: box(), [a.id]: box() }
  const gone = body(await send(x, group, { boxes: xBoxes })).message
  const kept = body(await send(x, group, { to: [a] })).message
  // As an earlier version left it: the profile removed and its direct file still
  // there; a deletion line and, before it, the message with its boxes.
  app.profiles.markRemoved(x.id)
  await app.close()
  fs.appendFileSync(chatFile(dir, group), '{"d":{"id":"' + gone.id + '","seq":3}}\n')
  assert.ok(fs.existsSync(chatFile(dir, ax)))
  const again = (await start(t, { dir })).app
  await waitFor(() => !fs.existsSync(chatFile(dir, ax)), { what: 'the direct file of the removed profile gone' })
  await waitFor(() => {
    const bytes = fs.readFileSync(chatFile(dir, group))
    return !holdsAny(bytes, xBoxes[x.id]) && !holdsAny(bytes, xBoxes[a.id])
  }, { what: 'the deleted boxes gone from the group file' })
  assert.equal(again.chat.get(ax), null)
  const a2 = a.on(again)
  assert.deepEqual((await messages(a2, group)).messages.map((y) => [y.id, y.deleted === true]), [[kept.id, false], [gone.id, true]])
  assert.deepEqual(body(await a2.call('GET', '/api/chat/conversations')).conversations.map((c) => c.id), [group])
})
