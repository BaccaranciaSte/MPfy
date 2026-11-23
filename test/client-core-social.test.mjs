// The people part of the client core against real sources (server/app.mjs) on a
// local HyperDHT testnet: the card published on every social source (and only
// when the source's one is older, or of the same time and not this one), the
// settings both ways per section, a new device getting them back, the sealed
// mutes, the union of the people of two sources (cards checked, clocks apart,
// tags), a person's page and photo, and activity (coalesced, quiet while
// invisible or private, a source that is down skipped). An older source is never
// asked anything social.

import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import createTestnet from 'hyperdht/testnet.js'
import { createMPfy } from '../server/app.mjs'
import { apiError } from '../server/errors.mjs'
import { createClientCore, ACTIVITY_GAP_MS } from '../client-core/index.js'
import { profileKeys, profileIdText } from '../client-core/identity.js'
import { makeCard, directId } from '../client-core/people.js'
import { openMutes } from '../client-core/seal.js'
import { tmpDir, request, json, waitFor, cleanup, fakeJpeg } from './helpers.mjs'

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web')
const T = (n) => n.toString(16).padStart(24, '0')
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
const hex = (b) => Buffer.from(b).toString('hex')

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
  const dir = dataDir || c.dir(tmpDir('mpfy-ccs-src-'))
  const app = await createMPfy({
    dataDir: dir, port: 0, adminPort: 0, p2p: true, waitForDht: true, dht: node(), ffmpeg: null, fpcalc: null, sevenZip: null, debounceMs: 10, name, ...opts
  })
  c.close(app)
  return { app, dir, id: app.serverPublicKey.slice(0, 8) }
}

async function core (t, { statePath = null, deviceName = 'Banco di prova', ...opts } = {}) {
  const c = cleanup(t)
  const file = statePath || path.join(c.dir(tmpDir('mpfy-ccs-core-')), 'state.json')
  const events = []
  const logs = []
  const instance = createClientCore({ statePath: file, webRoot: WEB, port: 0, deviceName, onEvent: (e) => events.push(e), log: (l) => logs.push(l), dht: node(), ...opts })
  const { port } = await instance.start()
  const h = {
    core: instance,
    port,
    statePath: file,
    events,
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

async function addSource (h, src, social = 3) {
  const res = await h.call('POST', '/local/sources', { code: src.app.code })
  assert.equal(res.status, 201, res.body.toString())
  await waitFor(async () => {
    const e = await h.entry(src.id)
    return e && e.connected && e.social === social
  }, { timeout: 30000, what: 'the link and the first sync of ' + src.id })
}

async function patchSocial (h, body) {
  const res = await h.call('PATCH', '/local/social', body)
  assert.equal(res.status, 200, res.body.toString())
  return json(res).privacy
}

// Every call of a method of `obj`, with its arguments and when it came.
function spy (t, obj, name) {
  const orig = obj[name]
  const calls = []
  obj[name] = function (...args) {
    calls.push({ args, at: Date.now() })
    return orig.apply(this, args)
  }
  t.after(() => { obj[name] = orig })
  return calls
}

// Someone else on a source: a profile there with a card (made with their own keys).
function someone (srcs, name, { at = Date.now() - 1000, secret = crypto.randomBytes(32) } = {}) {
  const keys = profileKeys(secret)
  for (const s of srcs) {
    if (s.app.profiles.get(keys.id) === null) s.app.profiles.create(keys.id, hex(keys.signPublicKey))
    s.app.social.putCard(keys.id, makeCard(keys, name, null, at))
  }
  return { keys, id: keys.id }
}

const track = (n) => ({ trackId: T(n), title: 'Brano ' + n, artist: 'Lumen Marino', album: 'Ultimo traghetto' })
const play = (n) => ({ track: track(n), playing: true, now: true, recent: true })

// ------------------------------------------------------------------- the card

test('card: sent to a source whose card is older, not again when it holds this one; a rename sends a newer one; social 1, 0 and null in the sources and their events; an older source is never asked anything social', async (t) => {
  const s1 = await source(t, { name: 'Casa' })
  const old = await source(t, { name: 'Vecchia' })
  // A source from before the social part: GET /api/profile without it.
  old.app.social.stamps = () => undefined
  const asked = ['putCard', 'settings', 'putSettings', 'activity', 'people', 'person', 'photoFor'].map((m) => spy(t, old.app.social, m))
  const cards = spy(t, s1.app.social, 'putCard')

  const a = await core(t)
  const p = await newProfile(a, 'Bacca')
  assert.equal(p.pid, profileIdText(p.id))
  assert.equal((await a.get('/local/profile')).profile.pid, profileIdText(p.id))
  await addSource(a, s1)
  await waitFor(() => s1.app.social.card(p.id) !== null, { what: 'the card on the source' })
  const card = s1.app.social.card(p.id)
  assert.equal(card.name, 'Bacca')
  assert.equal(card.updatedAt, p.nameUpdatedAt)
  assert.equal(card.chatPublicKey, hex(profileKeys(a.readState().profile.secret).chatPublicKey))
  assert.equal(cards.length, 1)
  assert.equal(a.readState().sources[0].card, card.sig, 'the card the source keeps is remembered')
  const sourceEvents = a.events.filter((e) => e.type === 'sources').map((e) => e.sources.find((x) => x.id === s1.id)).filter(Boolean)
  assert.equal(sourceEvents[0].social, null, 'null until a sync tells')
  assert.equal(sourceEvents[sourceEvents.length - 1].social, 3, 'a source with chats and songs')

  // The same card again: nothing is sent, the times are equal.
  assert.equal((await a.call('POST', '/local/sync')).status, 200)
  assert.equal(cards.length, 1)

  // A rename: a newer card.
  assert.equal((await a.call('PATCH', '/local/profile', { name: 'Bacca B.' })).status, 200)
  await waitFor(() => s1.app.social.card(p.id).name === 'Bacca B.', { what: 'the newer card' })
  assert.equal(cards.length, 2)

  // The older source: social 0, and nothing social ever asked of it.
  await addSource(a, old, 0)
  assert.equal((await a.call('POST', '/local/sync')).status, 200)
  assert.equal((await a.call('PATCH', '/local/social', { showRecent: false })).status, 200)
  assert.equal((await a.call('PUT', '/local/activity', { track: track(1), playing: true })).status, 200)
  assert.equal((await a.get('/local/people')).supported, true)
  await a.call('POST', '/local/sync')
  await new Promise((resolve) => setTimeout(resolve, 300))
  for (const calls of asked) assert.equal(calls.length, 0)
  assert.equal(old.app.social.card(p.id), null)

  // With only older sources there is nothing social.
  const b = await core(t)
  await newProfile(b, 'Altro')
  await addSource(b, old, 0)
  const people = await b.get('/local/people')
  assert.equal(people.supported, false)
  assert.deepEqual(people.people, [])
  assert.equal((await b.get('/local/social')).supported, false)
  for (const calls of asked) assert.equal(calls.length, 0)
})

test('card: when a source keeps another card of this profile with the very same time, this one goes out a millisecond later', async (t) => {
  const src = await source(t)
  const a = await core(t)
  const p = await newProfile(a, 'Bacca')
  const keys = profileKeys(a.readState().profile.secret)
  const ours = makeCard(keys, 'Bacca', null, p.nameUpdatedAt)
  // What another device of this profile published before a rename reached it,
  // made to win the tie at the same time.
  let stale = null
  for (let i = 0; ; i++) {
    stale = makeCard(keys, 'Nome vecchio ' + i, null, p.nameUpdatedAt)
    if (stale.sig > ours.sig) break
  }
  src.app.profiles.create(keys.id, hex(keys.signPublicKey))
  src.app.social.putCard(keys.id, stale)
  const cards = spy(t, src.app.social, 'putCard')
  await addSource(a, src)
  await waitFor(() => src.app.social.card(keys.id).name === 'Bacca', { what: 'the newest content on the source' })
  const kept = src.app.social.card(keys.id)
  assert.equal(kept.updatedAt, p.nameUpdatedAt + 1)
  assert.equal(cards.length, 2, 'the tie, then the card a millisecond later')
  await waitFor(() => a.readState().sources[0].card === kept.sig, { what: 'the state remembers it' })
  await a.call('POST', '/local/sync')
  assert.equal(cards.length, 2, 'nothing more: the source holds a newer card')
})

// --------------------------------------------------------------- settings

test('settings: PATCH /local/social reaches every social source at once; both ways per section in one sync; another device gets them back', async (t) => {
  const s1 = await source(t, { name: 'Casa' })
  const s2 = await source(t, { name: 'Ufficio' })
  const a = await core(t)
  const p = await newProfile(a, 'Bacca')
  await addSource(a, s1)
  await addSource(a, s2)
  let social = await a.get('/local/social')
  assert.deepEqual(social, {
    supported: true,
    privacy: { invisible: false, showNow: true, privateSession: false, privateUntil: 0, showRecent: true, updatedAt: 0 },
    blocked: [],
    mutes: {}
  })

  const t0 = Date.now()
  let privacy = await patchSocial(a, { showRecent: false })
  assert.equal(privacy.showRecent, false)
  assert.ok(privacy.updatedAt >= t0 && privacy.updatedAt <= Date.now())
  for (const s of [s1, s2]) await waitFor(() => s.app.social.settings(p.id).privacy.showRecent === false, { what: 'the privacy on ' + s.id })
  privacy = await patchSocial(a, { privateSession: true })
  assert.equal(privacy.privateSession, true)
  assert.ok(Math.abs(privacy.privateUntil - (Date.now() + 6 * 3600 * 1000)) < 5000, 'six hours')
  for (const s of [s1, s2]) await waitFor(() => s.app.social.settings(p.id).privacy.privateUntil === privacy.privateUntil, { what: 'the session on ' + s.id })
  privacy = await patchSocial(a, { privateSession: false, showRecent: true })
  assert.deepEqual([privacy.privateSession, privacy.privateUntil, privacy.showRecent], [false, 0, true])
  for (const body of [{}, { foo: true }, { invisible: 'yes' }, { privateUntil: 5 }]) {
    const res = await a.call('PATCH', '/local/social', body)
    assert.equal(res.status, 400, JSON.stringify(body))
    assert.equal(json(res).code, 'bad_request')
  }

  // A newer blocked list on s1 (another device wrote it) and a newer privacy here:
  // one sync takes the first and sends the second, and s2 then gets the list.
  const other = crypto.randomBytes(16).toString('hex')
  s1.app.social.putSettings(p.id, { blocked: { ids: [other], updatedAt: Date.now() } })
  privacy = await patchSocial(a, { showNow: false })
  await waitFor(async () => (await a.get('/local/social')).blocked[0] === other, { what: 'the list taken from s1' })
  await waitFor(() => s1.app.social.settings(p.id).privacy.showNow === false, { what: 'the privacy sent to s1' })
  await waitFor(() => s2.app.social.settings(p.id).blocked.ids[0] === other, { what: 'the list sent on to s2' })

  // Another device of the same profile: everything comes back from a source.
  const { code } = await a.get('/local/profile/code')
  const b = await core(t, { deviceName: 'PC' })
  assert.equal((await b.call('POST', '/local/profile/import', { code })).status, 200)
  await addSource(b, s1)
  await waitFor(async () => (await b.get('/local/social')).blocked[0] === other, { what: 'the settings on the new device' })
  social = await b.get('/local/social')
  assert.equal(social.privacy.showNow, false)
  assert.equal(social.privacy.updatedAt, privacy.updatedAt)
  // And back: a change there reaches the first device at its next sync.
  await patchSocial(b, { invisible: true })
  await waitFor(() => s1.app.social.settings(p.id).privacy.invisible === true, { what: 'invisible on s1' })
  await a.call('POST', '/local/sync')
  await waitFor(async () => (await a.get('/local/social')).privacy.invisible === true, { what: 'invisible on the first device' })
})

test('settings: an invisible profile is never listed on a source added later, not even for a moment (the privacy goes there before the card), nor while the source refuses the privacy', async (t) => {
  const s1 = await source(t, { name: 'Casa' })
  const s2 = await source(t, { name: 'Nuova' })
  const s3 = await source(t, { name: 'Piena' })
  const a = await core(t)
  const p = await newProfile(a, 'Bacca')
  await addSource(a, s1)
  await waitFor(() => s1.app.social.card(p.id) !== null, { what: 'the card on s1' })
  await patchSocial(a, { invisible: true })
  await waitFor(() => s1.app.social.settings(p.id).privacy.invisible === true, { what: 'invisible on s1' })

  // Someone else on the new source, asking for the people at every card that arrives.
  // Seen as a person ("all"): never. Once the silent group entry is there, an
  // invisible member is listed as "chat" (card only), so the others' cores can box
  // group messages for them; the apps show "chat" people only with a conversation.
  const viewer = someone([s2, s3], 'Giulia')
  const seenOn = (s) => s.app.social.people(viewer.id, new Set([p.id, viewer.id])).people.some((x) => x.profileId === p.id && x.seen === 'all')
  let shown = false
  const orig = s2.app.social.putCard
  s2.app.social.putCard = function (...args) {
    const kept = orig.apply(this, args)
    if (seenOn(s2)) shown = true
    return kept
  }
  t.after(() => { s2.app.social.putCard = orig })
  await addSource(a, s2)
  await waitFor(() => s2.app.social.card(p.id) !== null, { what: 'the card on s2' })
  assert.equal(s2.app.social.settings(p.id).privacy.invisible, true)
  assert.equal(shown, false, 'listed on the new source between its card and its privacy')
  assert.equal(seenOn(s2), false)

  // A source that refuses the settings (as when its minute is full): the card waits with them.
  const putSettings = s3.app.social.putSettings
  s3.app.social.putSettings = function (pid, body) {
    if (pid === p.id) throw apiError('slow_down', { retryAt: Date.now() + 60000 })
    return putSettings.call(this, pid, body)
  }
  t.after(() => { s3.app.social.putSettings = putSettings })
  await addSource(a, s3)
  assert.equal((await a.call('POST', '/local/sync')).status, 200)
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(s3.app.social.card(p.id), null, 'no card without the privacy that hides it')
  assert.equal(seenOn(s3), false)
  // Once the source takes the settings, the card follows.
  s3.app.social.putSettings = putSettings
  assert.equal((await a.call('POST', '/local/sync')).status, 200)
  await waitFor(() => s3.app.social.card(p.id) !== null, { what: 'the card on s3' })
  assert.equal(s3.app.social.settings(p.id).privacy.invisible, true)
  assert.equal(seenOn(s3), false)
})

test('settings: never in the identity file; an identity brought in starts from the defaults and the sources give them back', async (t) => {
  const src = await source(t)
  const a = await core(t)
  const p = await newProfile(a, 'Bacca')
  await addSource(a, src)
  await patchSocial(a, { invisible: true, showNow: false })
  await waitFor(() => src.app.social.settings(p.id).privacy.invisible === true, { what: 'the settings on the source' })
  const exported = await a.get('/local/profile/export')
  const text = JSON.stringify(exported.identity)
  assert.ok(!text.includes('invisible') && !text.includes('social'), 'no settings in the identity file')
  await a.close()
  const dir = src.dir
  await src.app.close()

  const b = await core(t)
  assert.equal((await b.call('POST', '/local/profile/import', { identity: exported.identity })).status, 200)
  const social = await b.get('/local/social')
  assert.deepEqual(social.privacy, { invisible: false, showNow: true, privateSession: false, privateUntil: 0, showRecent: true, updatedAt: 0 })
  assert.deepEqual(b.readState().social.privacy.updatedAt, 0)
  assert.equal(b.readState().sources[0].social, null)

  // The source comes back: the settings come back from it.
  await source(t, { dataDir: dir })
  b.core.refresh()
  await waitFor(async () => (await b.get('/local/social')).privacy.invisible === true, { timeout: 60000, what: 'the settings back from the source' })
  assert.equal((await b.get('/local/social')).privacy.showNow, false)
})

test('mutes: sealed for the sources with the social key, opened on another device of the same profile; a box that does not open leaves them as they are', async (t) => {
  const src = await source(t)
  const secret = crypto.randomBytes(32)
  const keys = profileKeys(secret)
  const cid = 'ab'.repeat(16)
  const map = { [cid]: 0, ['cd'.repeat(16)]: Date.now() + 3600000 }
  const at = Date.now() - 1000
  const dir = cleanup(t).dir(tmpDir('mpfy-ccs-core-'))
  const statePath = path.join(dir, 'state.json')
  fs.writeFileSync(statePath, JSON.stringify({
    clientSeed: crypto.randomBytes(32).toString('hex'),
    profile: { id: keys.id, secret: keys.secret, name: 'Bacca', nameUpdatedAt: at, createdAt: at, photo: null, photoUpdatedAt: 0 },
    recovery: null,
    recoveryDeletes: [],
    social: { privacy: { invisible: false, showNow: true, privateUntil: 0, showRecent: true, updatedAt: 0 }, blocked: { ids: [], updatedAt: 0 }, mutes: { map, updatedAt: at } },
    sources: []
  }))
  const a = await core(t, { statePath })
  assert.deepEqual((await a.get('/local/social')).mutes, map)
  await addSource(a, src)
  await waitFor(() => src.app.social.settings(keys.id).mutes.updatedAt === at, { what: 'the box on the source' })
  const box = src.app.social.settings(keys.id).mutes.box
  assert.ok(!Buffer.from(box, 'base64').toString('latin1').includes(cid), 'nothing of it in clear')
  assert.deepEqual(openMutes(box, keys.socialKey), map)

  const b = await core(t, { deviceName: 'PC' })
  const { code } = await a.get('/local/profile/code')
  assert.equal((await b.call('POST', '/local/profile/import', { code })).status, 200)
  await addSource(b, src)
  await waitFor(async () => Object.keys((await b.get('/local/social')).mutes).length === 2, { what: 'the mutes on the other device' })
  assert.deepEqual((await b.get('/local/social')).mutes, map)

  // A box nobody of this profile sealed, with a newer time: left aside.
  src.app.social.putSettings(keys.id, { mutes: { box: crypto.randomBytes(80).toString('base64'), updatedAt: Date.now() } })
  await b.call('POST', '/local/sync')
  assert.deepEqual((await b.get('/local/social')).mutes, map)
  assert.ok(b.logs.some((l) => l.includes('mutes of a source left aside')))
})

// ----------------------------------------------------------------- people

test('people: the union of two sources, cards checked, the newest of everything with the clocks 90 s apart, tags on clashes, the page, the photo from the next source', async (t) => {
  const s1 = await source(t, { name: 'Casa' })
  // s2's clock is 90 s behind: its times are 90 s smaller for the same moment.
  const s2 = await source(t, { name: 'Ufficio', socialNow: () => Date.now() - 90000 })
  const a = await core(t, { peopleFreshMs: 0 })
  const me = await newProfile(a, 'Giulia')
  await addSource(a, s1)
  await addSource(a, s2)
  await waitFor(() => s1.app.social.card(me.id) !== null && s2.app.social.card(me.id) !== null, { what: 'my card on both' })

  const g = someone([s1], 'giulia')
  const marta = someone([s1], 'Marta', { at: Date.now() - 60000 })
  someone([s2], 'Marta B.', { secret: Buffer.from(marta.keys.secret, 'hex') })
  const k = someone([s1, s2], 'Kevin')
  // s2 hands out a card it changed: its signature no longer holds.
  s2.app.social._records.get(k.id).card.name = 'Falso'
  s1.app.social.activity(marta.id, play(1))
  await new Promise((resolve) => setTimeout(resolve, 50))
  s2.app.social.activity(marta.id, play(2))

  let res = await a.get('/local/people')
  assert.equal(res.supported, true)
  assert.match(res.v, /^[0-9a-f]{16}$/)
  assert.deepEqual(res.me, { id: me.id, pid: profileIdText(me.id), name: 'Giulia', photo: null, tag: profileIdText(me.id).slice(0, 4) })
  assert.deepEqual(res.people.map((x) => x.name), ['giulia', 'Kevin', 'Marta B.'], 'by name, the newest card')
  const [pg, pk, pm] = res.people
  assert.deepEqual(pg, {
    id: g.id, pid: profileIdText(g.id), name: 'giulia', tag: profileIdText(g.id).slice(0, 4), photo: null, seen: 'all', blocked: false, chat: directId(me.id, g.id), sources: [s1.id], now: null, last: null
  })
  assert.equal(pk.tag, null, 'no clash, no tag')
  assert.deepEqual(pk.sources, [s1.id], 'the forged card left out, the other kept')
  assert.ok(a.logs.some((l) => l.includes('does not verify') && l.includes(k.id)))
  assert.deepEqual(pm.sources.sort(), [s1.id, s2.id].sort())
  assert.equal(pm.now.trackId, T(2), 'the newest by this clock, not by the source\'s')
  assert.ok(Math.abs(pm.now.at - Date.now()) < 10000)
  assert.equal(pm.last.trackId, T(2))
  assert.equal(pm.last.artistPage, false)
  const v = res.v
  assert.equal((await a.get('/local/people')).v, v, 'nothing changed: the same v')
  s1.app.social.activity(g.id, play(3))
  res = await a.get('/local/people')
  assert.notEqual(res.v, v)
  assert.equal(res.people[0].now.trackId, T(3))

  // A person's page: the union of the pages, recent plays newest first by this clock.
  const page = await a.get('/local/people/' + marta.id)
  assert.equal(page.person.name, 'Marta B.')
  assert.equal(page.person.now.trackId, T(2))
  assert.deepEqual(page.recent.map((r) => r.trackId), [T(2), T(1)])
  assert.equal(page.person.hidden, undefined)
  for (const id of [crypto.randomBytes(16).toString('hex'), 'nope']) {
    const r = await a.call('GET', '/local/people/' + id)
    assert.equal(r.status, 404)
    assert.equal(json(r).code, 'not_found')
  }
  // Your own page: as the others see you, hidden while invisible.
  let own = await a.get('/local/people/' + me.id)
  assert.deepEqual([own.person.name, own.person.hidden, own.person.chat, own.person.tag], ['Giulia', false, null, profileIdText(me.id).slice(0, 4)])
  await patchSocial(a, { invisible: true })
  await waitFor(() => s1.app.social.settings(me.id).privacy.invisible && s2.app.social.settings(me.id).privacy.invisible, { what: 'invisible on both' })
  own = await a.get('/local/people/' + me.id)
  assert.deepEqual([own.person.hidden, own.person.now, own.recent], [true, null, []])
  assert.equal((await a.get('/local/people')).people.length, 3, 'an invisible person still sees everyone')

  // Marta's photo: s1 hands out other bytes under its name, s2 the right ones.
  const photo = fakeJpeg(41)
  const at = Date.now()
  for (const s of [s1, s2]) {
    s.app.profiles.setPhoto(marta.id, photo, at)
    s.app.social.putCard(marta.id, makeCard(marta.keys, 'Marta B.', sha(photo), at))
  }
  fs.writeFileSync(s1.app.profiles.photoFile(marta.id), fakeJpeg(42))
  const asked = [spy(t, s1.app.social, 'photoFor'), spy(t, s2.app.social, 'photoFor')]
  res = await a.get('/local/people')
  assert.equal(res.people.find((x) => x.id === marta.id).photo, sha(photo))
  let r = await a.call('GET', '/local/people/' + marta.id + '/photo?v=' + sha(photo))
  assert.equal(r.status, 200, r.body.toString())
  assert.ok(r.body.equals(photo), 'the bytes that hash to the card')
  assert.equal(r.headers['content-type'], 'image/jpeg')
  assert.equal(r.headers['cache-control'], 'private, max-age=31536000, immutable')
  assert.equal(r.headers.etag, '"' + sha(photo) + '"')
  assert.ok(a.logs.some((l) => l.includes('not the photo of the card')), 'the first source refused')
  assert.deepEqual(asked.map((x) => x.length), [1, 1])
  r = await a.call('GET', '/local/people/' + marta.id + '/photo?v=' + sha(photo))
  assert.ok(r.body.equals(photo))
  assert.deepEqual(asked.map((x) => x.length), [1, 1], 'kept here: no source asked again')
  r = await a.call('GET', '/local/people/' + marta.id + '/photo')
  assert.equal(r.headers['cache-control'], 'no-cache')
  assert.equal((await a.call('GET', '/local/people/' + marta.id + '/photo', null, { 'if-none-match': '"' + sha(photo) + '"' })).status, 304)
  for (const url of ['/local/people/' + marta.id + '/photo?v=' + 'a'.repeat(64), '/local/people/' + g.id + '/photo']) {
    r = await a.call('GET', url)
    assert.equal(r.status, 404)
    assert.equal(json(r).code, 'no_photo')
  }
})

// ---------------------------------------------------------------- activity

test('activity: to every connected social source with the switches; 10 calls in 100 ms are 2 reports; quiet while invisible, private or with both switches off; a source down is skipped', async (t) => {
  assert.equal(ACTIVITY_GAP_MS, 6000, '10 reports a minute at most')
  const s1 = await source(t, { name: 'Casa' })
  const s2 = await source(t, { name: 'Ufficio' })
  const got = [spy(t, s1.app.social, 'activity'), spy(t, s2.app.social, 'activity')]
  // The gap at 1 s here (6 s in the app): the same rules, a shorter wait.
  const gap = 1000
  const a = await core(t, { activityGapMs: gap })
  await newProfile(a, 'Bacca')
  await addSource(a, s1)
  await addSource(a, s2)

  for (const bad of [{ track: null }, { track: { trackId: 'x', title: 'a' }, playing: true }, { track: { trackId: T(1) }, playing: true }, { track: track(1), playing: 'yes' }, { track: null, playing: false, now: true }, { track: { ...track(1), context: 'album' }, playing: true }]) {
    const r = await a.call('PUT', '/local/activity', bad)
    assert.equal(r.status, 400, JSON.stringify(bad))
    assert.equal(json(r).code, 'bad_request')
  }
  const started = Date.now()
  for (let i = 1; i <= 10; i++) {
    const r = await a.call('PUT', '/local/activity', { track: { ...track(i), artistPage: i === 10 }, playing: true })
    assert.deepEqual(json(r), { ok: true })
  }
  assert.ok(Date.now() - started < 2000, 'answered at once')
  await waitFor(() => got.every((x) => x.length === 2), { timeout: 15000, what: 'the second report, a gap later' })
  await new Promise((resolve) => setTimeout(resolve, 500))
  for (const calls of got) {
    assert.equal(calls.length, 2, 'the first call, then the latest one')
    assert.equal(calls[0].args[1].track.trackId, T(1))
    assert.deepEqual(calls[1].args[1], { track: { ...track(10), artistPage: true }, playing: true, now: true, recent: true })
    assert.ok(calls[1].at - calls[0].at >= gap - 100, 'a gap between two starts')
  }
  // The switches travel with every report.
  await patchSocial(a, { showNow: false })
  await new Promise((resolve) => setTimeout(resolve, gap))
  await a.call('PUT', '/local/activity', { track: track(11), playing: false })
  await waitFor(() => got.every((x) => x.length === 3), { what: 'the report with the switches' })
  assert.deepEqual(got[0][2].args[1], { track: { ...track(11), artistPage: false }, playing: false, now: false, recent: true })

  // Quiet: nothing goes out.
  for (const quiet of [{ invisible: true }, { invisible: false, privateSession: true }, { privateSession: false, showNow: false, showRecent: false }]) {
    await patchSocial(a, quiet)
    await new Promise((resolve) => setTimeout(resolve, gap + 100))
    await a.call('PUT', '/local/activity', { track: track(12), playing: true })
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.deepEqual(got.map((x) => x.length), [3, 3], JSON.stringify(quiet))
  }
  await patchSocial(a, { showNow: true, showRecent: true })

  // A source that is down is skipped, the other gets it at once.
  await s2.app.close()
  await waitFor(async () => (await a.entry(s2.id)).connected === false, { timeout: 30000, what: 's2 down' })
  await new Promise((resolve) => setTimeout(resolve, gap + 100))
  const t0 = Date.now()
  const r = await a.call('PUT', '/local/activity', { track: track(13), playing: true })
  assert.equal(r.status, 200)
  assert.ok(Date.now() - t0 < 1000)
  await waitFor(() => got[0].length === 4, { what: 'the report to s1' })
  assert.equal(got[0][3].args[1].track.trackId, T(13))
  assert.equal(got[1].length, 3)
})

test('activity: a burst over a minute is at most one report per gap (60 calls, 10 gaps)', async (t) => {
  const src = await source(t)
  const got = spy(t, src.app.social, 'activity')
  const gap = 200
  const a = await core(t, { activityGapMs: gap })
  await newProfile(a, 'Bacca')
  await addSource(a, src)
  // 60 calls spread over 10 gaps: the scale of 60 skips in a minute with 6 s between reports.
  const started = Date.now()
  for (let i = 1; i <= 60; i++) {
    await a.call('PUT', '/local/activity', { track: track(i), playing: true })
    const due = started + (i * gap * 10) / 60
    if (due > Date.now()) await new Promise((resolve) => setTimeout(resolve, due - Date.now()))
  }
  await new Promise((resolve) => setTimeout(resolve, gap * 3))
  const inWindow = got.filter((c) => c.at < started + gap * 10).length
  assert.ok(inWindow <= 10 + 1, 'at most one per gap: ' + inWindow)
  assert.ok(got.length >= 5, 'reports went out: ' + got.length)
  for (let i = 1; i < got.length; i++) assert.ok(got[i].at - got[i - 1].at >= gap * 0.75, 'spaced by the gap')
  assert.equal(got[got.length - 1].args[1].track.trackId, T(60), 'the latest call is the last report')
})
