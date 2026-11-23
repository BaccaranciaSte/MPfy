// The chats of the client core against real sources (server/app.mjs) on a local
// HyperDHT testnet: the box of the vectors and what a box must match to be shown, the union
// of two sources (one copy, order, a deletion from one, unread once, read marks
// carried to the source that lags), merged groups and their split, recipients
// without a signed card, the outbox (a source down, a restart, the 30 days and the
// 500), one send per id, every source refusing, blocks and mutes, the long poll,
// playlist cards read from the source that keeps them, the silent group entry, no
// message text on disk, a message deleted elsewhere leaving the outbox, a quote of
// a message deleted for everyone keeping its sender only, and a conversation a
// source no longer holds leaving the core.

import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import createTestnet from 'hyperdht/testnet.js'
import { createMPfy } from '../server/app.mjs'
import { apiError } from '../server/errors.mjs'
import { accessValid } from '../server/chat.mjs'
import { createClientCore } from '../client-core/index.js'
import { profileKeys } from '../client-core/identity.js'
import { makeCard, directId, groupId } from '../client-core/people.js'
import { sealBox, openBox, readMessage } from '../client-core/seal.js'
import {
  Chats, buildPlaintext, contentOf, cleanChatText, cleanLine, cleanCard, previewOf, makeAccess, OUTBOX_MAX
} from '../client-core/chat.js'
import { tmpDir, request, json, waitFor, cleanup } from './helpers.mjs'

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web')
const hex = (b) => Buffer.from(b).toString('hex')
const hex16 = () => crypto.randomBytes(16).toString('hex')
const T = (n) => n.toString(16).padStart(24, '0')
const BOX_VECTOR = 'MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzIGuLgZwv5YbBVmZYXBk6ywUtAblXDsqanLPvxSKltdsjV0dSeUGh4Si3RDK2uKYIgKtavYhq8dNwVsUPbCKAlxS9PcXtYospzv7F1jQJ+UPgKtMoMYgKiom76pIJmVHNuF1a9APTwsDdJH2h6/qIt1vCAGU68h+Zc/zu5IbnSl9xmqP2xZEDTRmR8x3RMCJCB+SpY0H3hlr7uRAcleJB9wT85hQjBQfrZo+animGE4ehGaZHmKZ1io34Hce8IA=='

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

// ------------------------------------------------------------------ helpers

async function source (t, { name = 'Fonte', dataDir = null, ...opts } = {}) {
  const c = cleanup(t)
  const dir = dataDir || c.dir(tmpDir('mpfy-ccc-src-'))
  const app = await createMPfy({
    dataDir: dir, port: 0, adminPort: 0, p2p: true, waitForDht: true, dht: node(), ffmpeg: null, fpcalc: null, sevenZip: null, debounceMs: 10, name, ...opts
  })
  c.close(app)
  return { app, dir, id: app.serverPublicKey.slice(0, 8), group: groupId(app.serverPublicKey) }
}

async function core (t, { statePath = null, ...opts } = {}) {
  const c = cleanup(t)
  const file = statePath || path.join(c.dir(tmpDir('mpfy-ccc-core-')), 'state.json')
  const logs = []
  const instance = createClientCore({
    statePath: file, webRoot: WEB, port: 0, deviceName: 'Banco di prova', log: (l) => logs.push(l), dht: node(),
    chatFreshMs: 300, chatHoldSeconds: 3, chatGroupFreshMs: 300, peopleFreshMs: 300, ...opts
  })
  const { port } = await instance.start()
  const h = {
    core: instance,
    port,
    statePath: file,
    logs,
    close: () => instance.stop(),
    readState: () => JSON.parse(fs.readFileSync(file, 'utf8')),
    call: (method, p, body, headers = {}) => request(port, method, p, { body, headers, timeout: 90000 }),
    get: async (p) => json(await request(port, 'GET', p, { timeout: 30000 })),
    entry: async (id) => (await h.get('/local/sources')).sources.find((s) => s.id === id)
  }
  c.close(h)
  return h
}

async function newProfile (h, name) {
  const res = await h.call('POST', '/local/profile', { name })
  assert.equal(res.status, 201, res.body.toString())
  return json(res).profile
}

async function addSource (h, src, profileId) {
  const res = await h.call('POST', '/local/sources', { code: src.app.code })
  assert.equal(res.status, 201, res.body.toString())
  await waitFor(async () => {
    const e = await h.entry(src.id)
    return e && e.connected && e.social >= 2
  }, { timeout: 30000, what: 'the link and the first sync of ' + src.id })
  await waitFor(() => src.app.social.cardOf(profileId) !== null, { timeout: 30000, what: 'the card on ' + src.id })
}

// Someone whose keys the test holds: a profile and a card on these sources.
function someone (srcs, name, secret = crypto.randomBytes(32)) {
  const keys = profileKeys(secret)
  for (const s of srcs) {
    if (s.app.profiles.get(keys.id) === null) s.app.profiles.create(keys.id, hex(keys.signPublicKey))
    s.app.social.putCard(keys.id, makeCard(keys, name, null, Date.now() - 1000))
  }
  return { keys, id: keys.id, name }
}

// A message written by `x` straight into a source, with real boxes: what a core
// of x would send. `fields` change the record (or its plaintext) to make a bad one.
async function write (src, cid, x, recipients, { id = hex16(), at = Date.now(), text = 'ciao', card = null, c = [cid], pl = null, recordId = null, recordAt = null, senderKey = null } = {}) {
  const plain = buildPlaintext({ id, from: x.id, at, c, t: card !== null ? 'card' : 'text', text, card })
  const to = [x.id, ...recipients.filter((r) => r !== x.id)]
  const boxes = to.map((pid) => sealBox(plain, Buffer.from(src.app.social.cardOf(pid).chatPublicKey, 'hex'), senderKey || x.keys.chatSecretKey))
  const group = cid === src.group
  const parties = group ? [null, null] : [x.id, recipients[0]].sort()
  const r = await src.app.chat.post(cid, group ? 'group' : 'direct', parties[0], parties[1], x.id, { id: recordId || id, at: recordAt || at, pl, to, boxes })
  return r.entry
}

const chats = async (h) => h.get('/local/chat/conversations')
const convOf = async (h, cid) => (await chats(h)).conversations.find((c) => c.ids.includes(cid))
const messagesOf = async (h, cid, q = '') => h.get('/local/chat/' + cid + '/messages' + q)

// Every call of a method of `obj`.
function spy (t, obj, name) {
  const orig = obj[name]
  const calls = []
  obj[name] = function (...args) {
    calls.push(args)
    return orig.apply(this, args)
  }
  t.after(() => { obj[name] = orig })
  return calls
}

// --------------------------------------------------------------- vectors

test('vectors: the plaintext and the box of A to B byte for byte; a box opens only where it belongs (conversation, id, sender, time); the access entry signs what the source checks', () => {
  const a = profileKeys(Buffer.from([...Array(32).keys()]))
  const b = profileKeys(Buffer.from(Array.from({ length: 32 }, (_, i) => 0x20 + i)))
  const ab = directId(a.id, b.id)
  assert.equal(ab, 'ab25e6e72ec668e6e39fbbb7ff239a74')
  const plain = buildPlaintext({ id: '00112233445566778899aabbccddeeff', from: a.id, at: 1763380060000, c: [ab], t: 'text', text: 'ciao' })
  assert.equal(plain.toString(), '{"v":1,"id":"00112233445566778899aabbccddeeff","from":"22de25661c578b57b919dfcada067bd4","at":1763380060000,"c":["ab25e6e72ec668e6e39fbbb7ff239a74"],"t":"text","text":"ciao"}')
  const box = sealBox(plain, b.chatPublicKey, a.chatSecretKey, Buffer.alloc(24, 0x33))
  assert.equal(box, BOX_VECTOR)
  const record = { id: '00112233445566778899aabbccddeeff', from: a.id, at: 1763380060000, conversation: ab }
  const opened = readMessage(openBox(box, a.chatPublicKey, b.chatSecretKey), record)
  assert.deepEqual(contentOf(opened), { t: 'text', text: 'ciao', card: null, reply: null })
  // Moved: another conversation, another id, another time; A's own box as from B.
  const at = openBox(box, a.chatPublicKey, b.chatSecretKey)
  assert.equal(readMessage(at, { ...record, conversation: '00'.repeat(16) }), null)
  assert.equal(readMessage(at, { ...record, id: 'ff'.repeat(16) }), null)
  assert.equal(readMessage(at, { ...record, at: record.at + 1 }), null)
  const atA = openBox(box, b.chatPublicKey, a.chatSecretKey)
  assert.notEqual(atA, null, 'the key of two people is the same both ways')
  assert.equal(readMessage(atA, { ...record, from: b.id }), null, 'dropped on its sender')
  // Another sender key than the card's: it does not open.
  const other = profileKeys(crypto.randomBytes(32))
  assert.equal(openBox(box, other.chatPublicKey, b.chatSecretKey), null)

  // Texts and contents.
  assert.equal(cleanChatText(' riga uno\r\nriga\u0007 due\rtre\u2028 '), 'riga uno\nriga due\ntre')
  assert.equal(cleanLine(' una\nnota\t  con\u0000 spazi '), 'una nota con spazi')
  assert.equal(contentOf({ t: 'text', text: 'x'.repeat(2001) }), null)
  assert.equal(contentOf({ t: 'text', text: '' }), null)
  assert.equal(contentOf({ t: 'card', card: { kind: 'track', id: 'zz', title: 'A' } }), null)
  assert.equal(contentOf({ t: 'card', card: { kind: 'track', id: T(1), title: 'A', sub: 'B' }, text: 'n'.repeat(301) }), null)
  assert.deepEqual(cleanCard({ kind: 'playlist', id: 'ab'.repeat(8), title: 'Per sabato', n: 3, sources: ['12345678', 'nope'], tracks: [T(1)] }),
    { kind: 'playlist', id: 'ab'.repeat(8), title: 'Per sabato', sub: '', n: 3, sources: ['12345678'], cover: null }, 'no track list in a card')
  assert.equal(previewOf({ t: 'card', card: { kind: 'track', title: 'Ultimo traghetto' } }), 'Brano: Ultimo traghetto')
  assert.equal(previewOf({ t: 'card', card: { kind: 'album', title: 'Lumen' } }), 'Album: Lumen')
  assert.equal(previewOf({ t: 'card', card: { kind: 'playlist', title: 'Per sabato' } }), 'Playlist: Per sabato')
  assert.equal(previewOf({ t: 'text', text: 'x'.repeat(150) }).length, 100)

  const g = groupId('22'.repeat(32))
  assert.equal(g, 'cac44b906c75b7bce7fd9f8b78224c35')
  const entry = makeAccess(a, g, 1763380060000)
  assert.equal(accessValid(hex(a.signPublicKey), a.id, g, 1763380060000, entry.sig), true)
  assert.equal(accessValid(hex(a.signPublicKey), a.id, g, 1763380060001, entry.sig), false)
})

test('outbox file: entries older than 30 days dropped when read, 500 at most (the oldest go)', (t) => {
  const dir = cleanup(t).dir(tmpDir('mpfy-ccc-outbox-'))
  const file = path.join(dir, 'state.json.chat-outbox.json')
  const now = Date.now()
  const entry = (i, at) => ({ source: '12345678', cid: '00'.repeat(16), op: 'post', body: { id: i.toString(16).padStart(32, '0') }, at })
  const list = [entry(0, now - 31 * 24 * 3600 * 1000), ...Array.from({ length: 10 }, (_, i) => entry(i + 1, now)), { source: 'x', cid: 'y', op: 'post', body: {}, at: now }]
  fs.writeFileSync(file, JSON.stringify(list))
  const fakeCore = { _log: () => {} }
  const c = new Chats(fakeCore, { outboxPath: file })
  assert.deepEqual(c.outbox().map((e) => e.body.id), list.slice(1, 11).map((e) => e.body.id), 'the old and the broken one left out')
  for (let i = 0; i < OUTBOX_MAX; i++) c._queue(entry(100 + i, now))
  assert.equal(OUTBOX_MAX, 500)
  assert.equal(c.outbox().length, 500)
  assert.equal(c.outbox()[0].body.id, (100).toString(16).padStart(32, '0'), 'the oldest went')
  return c.settle().then(() => {
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).length, 500)
    assert.equal(fs.statSync(file).mode & 0o777 & (process.platform === 'win32' ? 0 : 0o077), 0, '0600')
  })
})

// ------------------------------------------------------------------ union

test('union of two sources: one copy, by time then id; a deletion on one removes it; unread once; forged boxes dropped; the read mark carried to the source that lags', { timeout: 180000 }, async (t) => {
  const s1 = await source(t, { name: 'Casa' })
  const s2 = await source(t, { name: 'Mare' })
  const b = await core(t)
  const pb = await newProfile(b, 'Bruno')
  await addSource(b, s1, pb.id)
  await addSource(b, s2, pb.id)
  const x = someone([s1, s2], 'Xenia')
  const xb = directId(x.id, pb.id)
  const at = Date.now() - 5000
  // m1 on both sources; m2 and m3 at the same time (by id), on one source each.
  const [lo, hi] = [hex16(), hex16()].sort()
  const m1 = hex16()
  await write(s1, xb, x, [pb.id], { id: m1, at: at - 1000, text: 'primo' })
  await write(s2, xb, x, [pb.id], { id: m1, at: at - 1000, text: 'primo' })
  await write(s2, xb, x, [pb.id], { id: hi, at, text: 'due' })
  await write(s1, xb, x, [pb.id], { id: lo, at, text: 'tre' })
  // Forged on s1: a box under another id, a box moved from the group's conversation,
  // a box made with a key that is not the card's.
  const groupBox = await write(s1, s1.group, x, [pb.id], { text: 'nel gruppo' })
  void groupBox
  await write(s1, xb, x, [pb.id], { recordId: hex16(), text: 'altro id' })
  await write(s1, xb, x, [pb.id], { c: [s1.group], text: 'spostato' })
  await write(s1, xb, x, [pb.id], { senderKey: profileKeys(crypto.randomBytes(32)).chatSecretKey, text: 'chiave falsa' })
  await write(s1, xb, x, [pb.id], { recordAt: at + 1, text: 'altra ora' })
  // A third person's own box for B, saying it belongs to the conversation of X and B:
  // it opens, but X and B are the only ones who write there.
  const y = someone([s1], 'Ylenia')
  await write(s1, xb, y, [pb.id], { text: 'non sono di qui' })

  await waitFor(async () => {
    const m = await messagesOf(b, xb)
    return m.messages && m.messages.length === 3
  }, { timeout: 30000, what: 'the three messages' })
  let page = await messagesOf(b, xb)
  assert.deepEqual(page.messages.map((m) => m.text), ['primo', 'tre', 'due'], 'by time, then by id')
  assert.deepEqual(page.messages[0], { id: m1, from: x.id, name: 'Xenia', mine: false, at: at - 1000, t: 'text', text: 'primo', state: 'sent', preview: 'primo' })
  assert.ok(b.logs.some((l) => l.includes('does not open or does not belong there')))
  let conv = await convOf(b, xb)
  assert.equal(conv.unread, 3, 'counted once')
  assert.equal(conv.display, 'Xenia')
  assert.deepEqual(conv.sources.slice().sort(), [s1.id, s2.id].sort())
  assert.equal(conv.kind, 'direct')
  assert.equal(conv.with, x.id)
  assert.equal(conv.last.text, 'due')

  // A deletion on one source removes it from the union.
  await s2.app.chat.remove(s2.app.chat.get(xb), x.id, m1)
  await waitFor(async () => (await messagesOf(b, xb)).messages.length === 2, { timeout: 30000, what: 'the deletion' })
  conv = await convOf(b, xb)
  assert.equal(conv.unread, 2)

  // Another device of B marked "lo" read on s1 only: s2 gets the mark at its next list.
  await s1.app.chat.read(s1.app.chat.get(xb), pb.id, { at, id: lo })
  await waitFor(async () => {
    await chats(b)
    const r = s2.app.chat.get(xb).reads.get(pb.id)
    return r !== undefined && r.id === lo
  }, { timeout: 30000, what: 'the mark on s2' })
  assert.equal((await convOf(b, xb)).unread, 1, 'only "due" is after the mark')
  // Reading here: both sources get it, once.
  const reads = spy(t, s1.app.chat, 'read')
  assert.deepEqual(json(await b.call('PUT', '/local/chat/' + xb + '/read', { id: hi })), { ok: true })
  await waitFor(() => s1.app.chat.get(xb).reads.get(pb.id).id === hi && s2.app.chat.get(xb).reads.get(pb.id).id === hi, { what: 'the mark on both' })
  assert.equal((await convOf(b, xb)).unread, 0)
  const n = reads.length
  assert.deepEqual(json(await b.call('PUT', '/local/chat/' + xb + '/read', { id: lo })), { ok: true })
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(reads.length, n, 'a mark that does not move sends nothing')
  assert.equal((await b.call('PUT', '/local/chat/' + xb + '/read', { id: hex16() })).status, 404)
  // The page sends back the v it holds: nothing to read when it is still the one.
  await waitFor(async () => {
    const v = (await chats(b)).v
    const again = await b.call('GET', '/local/chat/conversations', null, { 'If-None-Match': '"' + v + '"' })
    return again.status === 304 && again.body.length === 0
  }, { what: 'a 304 for the list held' })
  const page2 = await messagesOf(b, xb)
  const held = await b.call('GET', '/local/chat/' + xb + '/messages', null, { 'If-None-Match': '"' + page2.v + '"' })
  assert.equal(held.status, 304)
  const other = await b.call('GET', '/local/chat/' + xb + '/messages', null, { 'If-None-Match': '"0000000000000000"' })
  assert.equal(other.status, 200)
  assert.equal(json(other).v, page2.v)
})

// --------------------------------------------------------------- groups

test('merged groups: the same people on two sources are one group under the principal\'s name, written to both with c holding both ids; someone joining one source splits them; a recipient without a signed card is never boxed for', { timeout: 180000 }, async (t) => {
  const s1 = await source(t, { name: 'Casa' })
  const s2 = await source(t, { name: 'Mare' })
  const b = await core(t)
  const pb = await newProfile(b, 'Bruno')
  await addSource(b, s1, pb.id)
  await addSource(b, s2, pb.id)
  const x = someone([s1, s2], 'Xenia')
  let group = null
  await waitFor(async () => {
    group = (await chats(b)).conversations.filter((c) => c.kind === 'group')
    return group.length === 1
  }, { timeout: 30000, what: 'one group' })
  assert.deepEqual(group[0].ids, [s1.group, s2.group], 'the principal first')
  assert.equal(group[0].id, s1.group)
  assert.equal(group[0].name, 'Casa')
  assert.equal(group[0].display, 'Casa')
  assert.equal(group[0].last, null)
  // Written to both, c holding both ids: Xenia opens it on each source.
  const r = await b.call('POST', '/local/chat/' + s2.group + '/messages', { text: 'ciao a tutti' })
  assert.equal(r.status, 201, r.body.toString())
  const sent = json(r).message
  assert.equal(sent.state, 'sent')
  assert.equal(sent.mine, true)
  for (const s of [s1, s2]) {
    await waitFor(() => s.app.chat.get(s.group) !== null && s.app.chat.get(s.group).byId.has(sent.id), { what: 'the message on ' + s.id })
    const conv = s.app.chat.get(s.group)
    const e = conv.byId.get(sent.id)
    assert.deepEqual([...e.to].sort(), [pb.id, x.id].sort())
    const boxes = await s.app.chat.readBoxes(conv, [e], x.id)
    const plain = readMessage(openBox(boxes.get(sent.id), Buffer.from(s.app.social.cardOf(pb.id).chatPublicKey, 'hex'), x.keys.chatSecretKey), { id: sent.id, from: pb.id, at: e.at, conversation: s.group })
    assert.deepEqual(plain.c, [s1.group, s2.group])
    assert.equal(plain.text, 'ciao a tutti')
  }
  // Read back from both: one copy.
  await waitFor(async () => (await messagesOf(b, s1.group)).messages.length === 1, { what: 'one copy' })

  // Someone joins s2 only: two groups again, each with what it holds.
  const y = someone([s2], 'Ylenia')
  await waitFor(async () => (await chats(b)).conversations.filter((c) => c.kind === 'group').length === 2, { timeout: 30000, what: 'the split' })
  const groups = (await chats(b)).conversations.filter((c) => c.kind === 'group')
  assert.deepEqual(groups.map((g) => g.ids.length), [1, 1])
  // A recipient a source lists without a card from it (none at all, or one from
  // another source only): never boxed for.
  const ghost = hex16()
  await waitFor(async () => (await b.get('/local/people')).people.some((p) => p.id === y.id), { what: 'Ylenia listed by s2' })
  const orig = s1.app.social.groupRecipients.bind(s1.app.social)
  s1.app.social.groupRecipients = (active) => [...orig(active), ghost, y.id].sort()
  t.after(() => { s1.app.social.groupRecipients = orig })
  await new Promise((resolve) => setTimeout(resolve, 400))
  const r2 = await b.call('POST', '/local/chat/' + s1.group + '/messages', { text: 'solo casa' })
  assert.equal(json(r2).message.state, 'sent')
  const e2 = s1.app.chat.get(s1.group).byId.get(json(r2).message.id)
  assert.ok(!e2.to.includes(ghost))
  assert.ok(!e2.to.includes(y.id), 'a card from another source does not count')
  assert.ok(b.logs.some((l) => l.includes('has no signed card from it')))
  assert.equal(s2.app.chat.get(s2.group).byId.has(json(r2).message.id), false, 'a separate group: not on s2')
})

// ---------------------------------------------------------------- outbox

test('outbox: a source that is down gets the message from the outbox at link-up, after a restart of the core too; the file holds boxes, never text', { timeout: 240000 }, async (t) => {
  const s1 = await source(t, { name: 'Casa' })
  let s2 = await source(t, { name: 'Mare' })
  const dir = path.join(cleanup(t).dir(tmpDir('mpfy-ccc-core-')), 'state.json')
  let b = await core(t, { statePath: dir })
  const pb = await newProfile(b, 'Bruno')
  await addSource(b, s1, pb.id)
  await addSource(b, s2, pb.id)
  const x = someone([s1, s2], 'Xenia')
  const xb = directId(x.id, pb.id)
  await waitFor(async () => (await b.get('/local/people')).people.some((p) => p.id === x.id && p.sources.length === 2), { what: 'Xenia on both' })
  const s2dir = s2.dir
  await s2.app.close()
  await waitFor(async () => (await b.entry(s2.id)).connected === false, { timeout: 30000, what: 's2 down' })
  const r = await b.call('POST', '/local/chat/' + xb + '/messages', { text: 'parola segreta' })
  assert.equal(r.status, 201, r.body.toString())
  const m = json(r).message
  assert.equal(m.state, 'sent', 'one source took it')
  assert.ok(s1.app.chat.get(xb).byId.has(m.id))
  const outbox = b.statePath + '.chat-outbox.json'
  await waitFor(() => fs.existsSync(outbox), { what: 'the outbox file' })
  const queued = JSON.parse(fs.readFileSync(outbox, 'utf8'))
  assert.equal(queued.length, 1)
  assert.equal(queued[0].source, s2.id)
  assert.equal(queued[0].op, 'post')
  assert.equal(queued[0].body.id, m.id)
  assert.ok(!fs.readFileSync(outbox, 'utf8').includes('parola segreta'))
  // A restart of the core keeps it.
  await b.close()
  b = await core(t, { statePath: dir })
  assert.equal(JSON.parse(fs.readFileSync(outbox, 'utf8')).length, 1)
  // The source comes back: it gets the message at link-up.
  s2 = await source(t, { dataDir: s2dir, name: 'Mare' })
  b.core.refresh()
  await waitFor(() => s2.app.chat.get(xb) !== null && s2.app.chat.get(xb).byId.has(m.id), { timeout: 90000, what: 'the message on s2' })
  await waitFor(() => !fs.existsSync(outbox), { what: 'the outbox emptied' })
  // No message text anywhere in the state folder.
  for (const f of fs.readdirSync(path.dirname(dir))) {
    const p = path.join(path.dirname(dir), f)
    if (fs.statSync(p).isFile()) assert.ok(!fs.readFileSync(p).toString('latin1').includes('parola segreta'), f)
  }
})

// Whether any 16 characters in a row of `s` are anywhere in `bytes`.
function holdsAny (bytes, s) {
  for (let k = 0; k + 16 <= s.length; k += 8) if (bytes.includes(s.slice(k, k + 16), 0, 'latin1')) return true
  return false
}

test('deleted for everyone from another device: it leaves the outbox here too, so a source that was down never gets it; on the source its boxes leave the file and the other messages still open, read again from nothing', { timeout: 240000 }, async (t) => {
  const s1 = await source(t, { name: 'Casa' })
  let s2 = await source(t, { name: 'Mare' })
  const dir = path.join(cleanup(t).dir(tmpDir('mpfy-ccc-core-')), 'state.json')
  let b = await core(t, { statePath: dir })
  const pb = await newProfile(b, 'Bruno')
  await addSource(b, s1, pb.id)
  await addSource(b, s2, pb.id)
  const x = someone([s1, s2], 'Xenia')
  const xb = directId(x.id, pb.id)
  await waitFor(async () => (await b.get('/local/people')).people.some((p) => p.id === x.id && p.sources.length === 2), { what: 'Xenia on both' })
  const at = Date.now() - 5000
  for (let i = 0; i < 3; i++) await write(s1, xb, x, [pb.id], { at: at + i, text: 'prima ' + i })
  await waitFor(async () => ((await messagesOf(b, xb)).messages || []).length === 3, { timeout: 30000, what: 'the first three' })
  const s2dir = s2.dir
  await s2.app.close()
  await waitFor(async () => (await b.entry(s2.id)).connected === false, { timeout: 30000, what: 's2 down' })
  const r = await b.call('POST', '/local/chat/' + xb + '/messages', { text: 'da non ricevere' })
  assert.equal(r.status, 201, r.body.toString())
  const m = json(r).message
  const outbox = b.statePath + '.chat-outbox.json'
  await waitFor(() => fs.existsSync(outbox), { what: 'the outbox file' })
  const conv = s1.app.chat.get(xb)
  const entry = conv.byId.get(m.id)
  const boxes = [...(await s1.app.chat.readBoxes(conv, [entry], pb.id)).values(), ...(await s1.app.chat.readBoxes(conv, [entry], x.id)).values()]
  assert.equal(boxes.length, 2)
  // Bruno deletes it from another device: on the source that is up.
  await s1.app.chat.remove(conv, pb.id, m.id)
  await waitFor(async () => {
    await chats(b)
    return !fs.existsSync(outbox)
  }, { timeout: 30000, what: 'the message gone from the outbox' })
  assert.deepEqual((await messagesOf(b, xb)).messages.map((y) => y.text), ['prima 0', 'prima 1', 'prima 2'])
  const file = path.join(s1.dir, 'chat', xb + '.ndjson')
  for (const v of boxes) assert.equal(holdsAny(fs.readFileSync(file), v), false, 'a box of the deleted message is still on the source')
  // Read again from nothing (a restart of the core): the others open from their places.
  await b.close()
  b = await core(t, { statePath: dir })
  await waitFor(async () => {
    const got = await messagesOf(b, xb)
    return got.messages && got.messages.map((y) => y.text).join() === 'prima 0,prima 1,prima 2'
  }, { timeout: 60000, what: 'the three read again' })
  // The source that was down comes back: it never gets the message.
  s2 = await source(t, { dataDir: s2dir, name: 'Mare' })
  b.core.refresh()
  await waitFor(async () => (await b.entry(s2.id)).connected === true, { timeout: 90000, what: 's2 back' })
  await chats(b)
  await new Promise((resolve) => setTimeout(resolve, 1000))
  const there = s2.app.chat.get(xb)
  assert.ok(there === null || !there.byId.has(m.id), 'the deleted message reached the source that was down')
})

test('a quote of a message deleted for everyone keeps its sender only: its words and its card leave with it', { timeout: 120000 }, async (t) => {
  const s1 = await source(t, { name: 'Casa' })
  const b = await core(t)
  const pb = await newProfile(b, 'Bruno')
  await addSource(b, s1, pb.id)
  const x = someone([s1], 'Xenia')
  const xb = directId(x.id, pb.id)
  await waitFor(async () => (await b.get('/local/people')).people.some((p) => p.id === x.id), { what: 'Xenia' })
  const at = Date.now() - 5000
  const said = await write(s1, xb, x, [pb.id], { at, text: 'non dirlo a nessuno' })
  const kept = await write(s1, xb, x, [pb.id], { at: at + 1, text: 'questo resta' })
  await waitFor(async () => ((await messagesOf(b, xb)).messages || []).length === 2, { timeout: 30000, what: 'her two' })
  for (const [q, text] of [[said, 'ho capito'], [kept, 'bene']]) {
    const r = await b.call('POST', '/local/chat/' + xb + '/messages', { text, replyTo: q.id })
    assert.equal(r.status, 201, r.body.toString())
  }
  const quotes = async () => Object.fromEntries((await messagesOf(b, xb)).messages.filter((m) => m.reply).map((m) => [m.text, m.reply]))
  assert.deepEqual(await quotes(), { 'ho capito': { id: said.id, from: x.id, text: 'non dirlo a nessuno' }, bene: { id: kept.id, from: x.id, text: 'questo resta' } })
  // She deletes it for everyone.
  await s1.app.chat.remove(s1.app.chat.get(xb), x.id, said.id)
  await waitFor(async () => {
    await chats(b)
    return !(await messagesOf(b, xb)).messages.some((m) => m.id === said.id)
  }, { timeout: 30000, what: 'her message gone' })
  assert.deepEqual(await quotes(), { 'ho capito': { id: said.id, from: x.id, gone: true }, bene: { id: kept.id, from: x.id, text: 'questo resta' } })
})

test('a person removed from a source: what only that source held of the direct conversation leaves the core, what another source holds stays; a conversation no source holds any more never comes back', { timeout: 180000 }, async (t) => {
  const s1 = await source(t, { name: 'Casa' })
  const s2 = await source(t, { name: 'Mare' })
  const b = await core(t)
  const pb = await newProfile(b, 'Bruno')
  await addSource(b, s1, pb.id)
  await addSource(b, s2, pb.id)
  const x = someone([s1, s2], 'Xenia')
  const ySecret = crypto.randomBytes(32)
  const y = someone([s1], 'Ylenia', ySecret)
  const xb = directId(x.id, pb.id)
  const yb = directId(y.id, pb.id)
  await waitFor(async () => {
    const people = (await b.get('/local/people')).people
    return people.some((p) => p.id === x.id && p.sources.length === 2) && people.some((p) => p.id === y.id)
  }, { what: 'Xenia on both, Ylenia on one' })
  const at = Date.now() - 5000
  const [only1, both, only2] = [hex16(), hex16(), hex16()]
  await write(s1, xb, x, [pb.id], { id: only1, at, text: 'solo a casa' })
  await write(s1, xb, x, [pb.id], { id: both, at: at + 1, text: 'su tutte e due' })
  await write(s2, xb, x, [pb.id], { id: both, at: at + 1, text: 'su tutte e due' })
  await write(s2, xb, x, [pb.id], { id: only2, at: at + 2, text: 'solo al mare' })
  await write(s1, yb, y, [pb.id], { at: at + 3, text: 'ciao da Ylenia' })
  const count = async (cid) => ((await messagesOf(b, cid)).messages || []).length
  await waitFor(async () => (await count(xb)) === 3 && (await count(yb)) === 1, { timeout: 30000, what: 'the messages' })
  s1.app.people.removeProfile(x.id)
  s1.app.people.removeProfile(y.id)
  await waitFor(async () => {
    const got = await messagesOf(b, xb)
    return got.messages && got.messages.map((z) => z.id).join() === [both, only2].join()
  }, { timeout: 30000, what: 'only what the other source holds' })
  await waitFor(async () => {
    const c = await convOf(b, xb)
    return c !== undefined && c.sources.join() === s2.id
  }, { timeout: 30000, what: 'the conversation on the other source only' })
  await waitFor(async () => (await convOf(b, yb)) === undefined, { timeout: 30000, what: 'the conversation with Ylenia gone' })
  // Ylenia joins the other source: nothing of the conversation that is gone shows again.
  someone([s2], 'Ylenia', ySecret)
  await waitFor(async () => (await b.get('/local/people')).people.some((p) => p.id === y.id), { timeout: 30000, what: 'Ylenia on the other source' })
  const page = await messagesOf(b, yb)
  assert.deepEqual(page.messages, [])
  assert.equal((await convOf(b, yb)), undefined)
})

// --------------------------------------------------------- sends, blocks, mutes

test('one send per id; failed when every source refuses; a block hides at once whatever the sources answer; mute for 8 hours, a week, always, off; the silent group entry; no text on disk', { timeout: 180000 }, async (t) => {
  const s1 = await source(t, { name: 'Casa' })
  const b = await core(t)
  const pb = await newProfile(b, 'Bruno')
  await addSource(b, s1, pb.id)
  // The silent entry in the group, made at the first sync.
  await waitFor(() => s1.app.chat.accessAt(pb.id) > 0, { what: 'the group entry' })
  const x = someone([s1], 'Xenia')
  const xb = directId(x.id, pb.id)
  await waitFor(async () => (await b.get('/local/people')).people.some((p) => p.id === x.id), { what: 'Xenia listed' })

  // A double tap: two POSTs with one id, one message.
  const posts = spy(t, s1.app.chat, 'post')
  const id = hex16()
  const [r1, r2] = await Promise.all([
    b.call('POST', '/local/chat/' + xb + '/messages', { id, text: 'una volta' }),
    b.call('POST', '/local/chat/' + xb + '/messages', { id, text: 'una volta' })
  ])
  assert.deepEqual([r1.status, r2.status].sort(), [200, 201])
  assert.equal(json(r1).message.id, id)
  assert.equal(json(r2).message.id, id)
  assert.equal(posts.length, 1)
  assert.equal(s1.app.chat.get(xb).seq, 1)
  for (const bad of [{ text: '' }, { text: '   ' }, { text: 'x'.repeat(2001) }, { card: { kind: 'track', id: 'x', title: 't' } }, { text: 'a', other: 1 }, { id: 'nope', text: 'a' }]) {
    assert.equal((await b.call('POST', '/local/chat/' + xb + '/messages', bad)).status, 400, JSON.stringify(bad).slice(0, 60))
  }
  assert.equal((await b.call('POST', '/local/chat/' + hex16() + '/messages', { text: 'a chi?' })).status, 404)
  // A card with a note, and a reply to it.
  let r = await b.call('POST', '/local/chat/' + xb + '/messages', { card: { kind: 'track', id: T(7), title: 'Ultimo traghetto', sub: 'Lumen Marino' }, text: 'per\nsabato' })
  const cardMsg = json(r).message
  assert.deepEqual(cardMsg.card, { kind: 'track', id: T(7), title: 'Ultimo traghetto', sub: 'Lumen Marino' })
  assert.equal(cardMsg.text, 'per sabato')
  assert.equal(cardMsg.preview, 'Brano: Ultimo traghetto')
  r = await b.call('POST', '/local/chat/' + xb + '/messages', { text: 'senti il ritornello', replyTo: cardMsg.id })
  assert.deepEqual(json(r).message.reply, { id: cardMsg.id, from: pb.id, text: 'per sabato', card: { kind: 'track', id: T(7), title: 'Ultimo traghetto' } })

  // Every source refuses: failed.
  const readPost = s1.app.chat.readPost
  s1.app.chat.readPost = () => { throw apiError('bad_message') }
  r = await b.call('POST', '/local/chat/' + xb + '/messages', { text: 'rifiutato' })
  s1.app.chat.readPost = readPost
  assert.equal(json(r).message.state, 'failed')
  assert.ok(!fs.existsSync(b.statePath + '.chat-outbox.json'), 'a refusal is not queued')

  // Delete: own only.
  await write(s1, xb, x, [pb.id], { text: 'da Xenia' })
  let theirs = null
  await waitFor(async () => {
    theirs = (await messagesOf(b, xb)).messages.find((m) => m.text === 'da Xenia')
    return theirs !== undefined
  }, { what: 'Xenia\'s message' })
  assert.equal((await b.call('DELETE', '/local/chat/' + xb + '/messages/' + theirs.id)).status, 403)
  assert.equal(json(await b.call('DELETE', '/local/chat/' + xb + '/messages/' + cardMsg.id)).ok, true)
  assert.ok(!(await messagesOf(b, xb)).messages.some((m) => m.id === cardMsg.id), 'gone here at once')
  await waitFor(() => s1.app.chat.get(xb).byId.get(cardMsg.id).k === 'd', { what: 'deleted on the source' })

  // Mutes.
  const before = Date.now()
  let mutes = json(await b.call('PUT', '/local/chat/' + xb + '/mute', { mute: '8h' })).mutes
  assert.ok(mutes[xb] >= before + 8 * 3600 * 1000 && mutes[xb] <= Date.now() + 8 * 3600 * 1000)
  mutes = json(await b.call('PUT', '/local/chat/' + xb + '/mute', { mute: '1w' })).mutes
  assert.ok(mutes[xb] >= before + 7 * 24 * 3600 * 1000 && mutes[xb] <= Date.now() + 7 * 24 * 3600 * 1000)
  mutes = json(await b.call('PUT', '/local/chat/' + xb + '/mute', { mute: 'always' })).mutes
  assert.equal(mutes[xb], 0)
  let conv = await convOf(b, xb)
  assert.equal(conv.muted, true)
  assert.equal(conv.mutedUntil, 0)
  assert.equal((await chats(b)).unread, 0, 'a muted conversation is not in the total')
  assert.equal(conv.unread, 1)
  mutes = json(await b.call('PUT', '/local/chat/' + xb + '/mute', { mute: 'off' })).mutes
  assert.equal(xb in mutes, false)
  assert.equal((await chats(b)).unread, 1)
  assert.equal((await b.call('PUT', '/local/chat/' + xb + '/mute', { mute: '2h' })).status, 400)
  assert.deepEqual((await b.get('/local/social')).mutes, {})
  await waitFor(() => s1.app.social.settings(pb.id).mutes.updatedAt > 0, { what: 'the mutes on the source' })

  // A block hides at once, whatever the source answers.
  s1.app.social.blocks = () => false
  await write(s1, s1.group, x, [pb.id], { text: 'nel gruppo' })
  await waitFor(async () => (await messagesOf(b, s1.group)).messages.length === 1, { what: 'the group message' })
  assert.deepEqual(json(await b.call('POST', '/local/social/blocked', { profileId: x.id })), { blocked: [x.id] })
  assert.equal(await convOf(b, xb), undefined, 'the direct conversation is gone')
  assert.equal((await messagesOf(b, s1.group)).messages.length, 0, 'the group message hidden')
  assert.equal((await b.call('GET', '/local/chat/' + xb + '/messages')).status, 404)
  assert.equal((await b.get('/local/people')).people.find((p) => p.id === x.id).blocked, true)
  assert.deepEqual(json(await b.call('DELETE', '/local/social/blocked/' + x.id)), { blocked: [] })
  assert.ok(await convOf(b, xb))
  assert.equal((await b.call('POST', '/local/social/blocked', { profileId: pb.id })).status, 400)
  assert.equal((await b.call('POST', '/local/social/blocked', { profileId: 'nope' })).status, 400)

  // Nothing of what was written is on disk.
  await b.close()
  const dir = path.dirname(b.statePath)
  for (const f of fs.readdirSync(dir)) {
    const text = fs.readFileSync(path.join(dir, f)).toString('utf8')
    for (const said of ['una volta', 'per sabato', 'senti il ritornello', 'da Xenia', 'nel gruppo']) assert.ok(!text.includes(said), f + ' holds "' + said + '"')
  }
})

// --------------------------------------------------------------- long poll

test('long poll: while the page asks, a message on the source is known here at once, without waiting for the next list', { timeout: 120000 }, async (t) => {
  const s1 = await source(t, { name: 'Casa' })
  // A list read again only after a minute: only the held request can bring news.
  const b = await core(t, { chatFreshMs: 60000, chatHoldSeconds: 20 })
  const pb = await newProfile(b, 'Bruno')
  await addSource(b, s1, pb.id)
  const x = someone([s1], 'Xenia')
  await waitFor(async () => (await b.get('/local/people')).people.some((p) => p.id === x.id), { what: 'Xenia listed' })
  const waits = spy(t, s1.app.chat, 'waitFor')
  await chats(b)
  await waitFor(() => waits.length > 0, { what: 'a held request' })
  const started = Date.now()
  await write(s1, directId(x.id, pb.id), x, [pb.id], { text: 'subito' })
  await waitFor(async () => (await chats(b)).unread === 1, { timeout: 8000, interval: 100, what: 'the message' })
  assert.ok(Date.now() - started < 8000)
  const conv = await convOf(b, directId(x.id, pb.id))
  assert.equal(conv.last.preview, 'subito')
})

test('a list far behind: after the jump to the newest page, what was held from before goes and comes back from the sources, without the deleted one and without a hole', { timeout: 180000 }, async (t) => {
  const s1 = await source(t, { name: 'Casa' })
  // No held list (a source that answers at once): only the page's asks read the source.
  const b = await core(t, { chatHoldSeconds: 0 })
  const pb = await newProfile(b, 'Bruno')
  await addSource(b, s1, pb.id)
  const x = someone([s1], 'Xenia')
  const xb = directId(x.id, pb.id)
  await waitFor(async () => (await b.get('/local/people')).people.some((p) => p.id === x.id), { what: 'Xenia listed' })
  const at = Date.now() - 600000
  const old = []
  for (let i = 0; i < 60; i++) old.push((await write(s1, xb, x, [pb.id], { at: at + i, text: 'vecchio ' + i })).id)
  await waitFor(async () => (await messagesOf(b, xb, '?limit=200')).messages.length === 60, { what: 'the first 60' })
  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.equal(s1.app.chat._waiters.size, 0, 'nothing held')
  // Nobody asks; meanwhile one of the old ones is deleted and 205 more come: more than a page.
  await s1.app.chat.remove(s1.app.chat.get(xb), x.id, old[59])
  const fresh = []
  for (let i = 0; i < 205; i++) fresh.push((await write(s1, xb, x, [pb.id], { at: at + 1000 + i, text: 'nuovo ' + i })).id)
  await waitFor(async () => {
    const m = await messagesOf(b, xb, '?limit=200')
    return m.messages.length === 200 && m.messages[199].id === fresh[204]
  }, { what: 'the newest page' })
  // Scrolling up from the oldest shown: the five before it, then the old ones, the deleted one never.
  const shown = (await messagesOf(b, xb, '?limit=200')).messages
  assert.equal(shown[0].id, fresh[5])
  const older = (await messagesOf(b, xb, '?limit=50&before=' + fresh[5])).messages.map((m) => m.id)
  assert.deepEqual(older, [...old.slice(14, 59), ...fresh.slice(0, 5)])
  assert.ok(!older.includes(old[59]), 'the deleted one stays gone')
})

// --------------------------------------------------------------- playlists

test('playlist cards: read whole and current from the source that keeps the playlist, the last copy when it is away; a card sent here names its source and the source learns which playlist', { timeout: 180000 }, async (t) => {
  const s1 = await source(t, { name: 'Casa' })
  const b = await core(t)
  const pb = await newProfile(b, 'Bruno')
  await addSource(b, s1, pb.id)
  const x = someone([s1], 'Xenia')
  const xb = directId(x.id, pb.id)
  await waitFor(async () => (await b.get('/local/people')).people.some((p) => p.id === x.id), { what: 'Xenia listed' })
  const user = s1.app.users.get(x.id)
  const pl = user.createPlaylist({ name: 'Per sabato' })
  user.updatePlaylist(pl.id, { trackIds: [T(1), T(2)] })
  const card = { kind: 'playlist', id: pl.id, title: 'Per sabato', sub: '', n: 2, sources: [s1.id], cover: null }
  const e = await write(s1, xb, x, [pb.id], { card, text: null, pl: pl.id })
  let got = null
  await waitFor(async () => {
    got = (await messagesOf(b, xb)).messages.find((m) => m.id === e.id)
    return got !== undefined
  }, { what: 'the card' })
  assert.deepEqual(got.card, card)
  const url = '/local/chat/' + xb + '/messages/' + e.id + '/playlist'
  let p = await b.get(url)
  assert.deepEqual(p.playlist.trackIds, [T(1), T(2)])
  assert.equal(p.playlist.n, 2)
  assert.equal(p.playlist.live, true)
  user.updatePlaylist(pl.id, { trackIds: [T(3), T(1), T(2)] })
  p = await b.get(url)
  assert.deepEqual(p.playlist.trackIds, [T(3), T(1), T(2)], 'as it is now')
  // B shares its own playlist: the card names the principal, the source learns the id.
  const mine = json(await b.call('POST', '/s/' + s1.id + '/api/playlists', { name: 'Mia' })).playlist
  const r = await b.call('POST', '/local/chat/' + xb + '/messages', { card: { kind: 'playlist', id: mine.id, title: 'Mia', n: 0 } })
  const sent = json(r).message
  assert.deepEqual(sent.card.sources, [s1.id])
  assert.equal(s1.app.chat.get(xb).byId.get(sent.id).pl, mine.id)
  // Named by the page: kept when the source holds the conversation, else left out.
  const r2 = await b.call('POST', '/local/chat/' + xb + '/messages', { card: { kind: 'playlist', id: mine.id, title: 'Mia', n: 0, sources: [s1.id, 'abcdef12'] } })
  assert.deepEqual(json(r2).message.card.sources, [s1.id])
  // The source away: the last copy read.
  await s1.app.close()
  await waitFor(async () => (await b.entry(s1.id)).connected === false, { timeout: 30000, what: 's1 down' })
  p = await b.get(url)
  assert.equal(p.playlist.live, false)
  assert.deepEqual(p.playlist.trackIds, [T(3), T(1), T(2)])
})
