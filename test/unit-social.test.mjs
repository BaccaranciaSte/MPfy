// The people part of a source: the profile card (its checks and the newest one
// kept), the private settings (privacy, blocks, the sealed mutes) per section,
// activity (now playing, the short recent list) as the privacy allows, who is
// served what (lists, pages, photos, ETag), the per-minute limits, the social
// files (one per person, their writes, a file that does not parse, the split of an
// older social.json) and the listening history of
// "Recenti" (1,000 plays kept, 50 in the library, pages of /api/recents).

import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createMPfy } from '../server/app.mjs'
import { SocialStore, cardBytes, cardProblem, cardWins, MAX_MUTES_BYTES, RATE_LIMITS } from '../server/social.mjs'
import { Users, MAX_HISTORY } from '../server/users.mjs'
import { tmpDir, cleanup, request, json, makeProfile, makeCard, chatKeysOf, device, testWhoIs, fakeJpeg, waitFor } from './helpers.mjs'

const T = (n) => n.toString(16).padStart(24, '0')
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
const MIN = 60 * 1000

// A clock that stands still until the test moves it: the social part of the source reads it.
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

// A person on the source: a device with a profile, its card published.
async function person (app, name, { card = true, cardTime = Date.now() - 1000 } = {}) {
  const profile = makeProfile()
  const d = device(app, { profile })
  if (card) {
    const r = await d.call('PUT', '/api/profile/card', { body: makeCard(profile, { name, updatedAt: cardTime }) })
    assert.equal(r.status, 200, r.body.toString())
  } else {
    assert.equal((await d.call('GET', '/api/profile')).status, 200)
  }
  return { ...d, profile, id: profile.id, name }
}

const body = (r) => json(r)
const track = (n, extra = {}) => ({ trackId: T(n), title: 'Brano ' + n, artist: 'Lumen Marino', album: 'Ultimo traghetto', ...extra })
const report = (who, t, { playing = true, now = true, recent = true } = {}) => who.call('PUT', '/api/activity', { body: { track: t, playing, now, recent } })
const privacy = (fields) => ({ invisible: false, showNow: true, privateUntil: 0, showRecent: true, updatedAt: Date.now(), ...fields })

async function list (who, headers = {}) {
  const r = await who.call('GET', '/api/people', { headers })
  assert.equal(r.status, 200, r.body.toString())
  return body(r)
}

async function expectCode (pending, status, code) {
  const r = await pending
  assert.equal(r.status, status, r.body.toString())
  assert.equal(body(r).code, code, r.body.toString())
  return body(r)
}

// ----------------------------------------------------------------- cards

test('card: the vector of A verifies byte for byte; each rule refuses; the newest is kept', () => {
  const a = makeProfile(Buffer.from([...Array(32).keys()]))
  assert.equal(a.id, '22de25661c578b57b919dfcada067bd4')
  assert.equal(chatKeysOf(a.secret).publicKey.toString('hex'), 'd82c0f67c35fa61aff7e4eb051b36cd9758ca253d072f18d335218c86640b968')
  const card = makeCard(a, { name: 'Bacca', photo: null, updatedAt: 1763380004000 })
  assert.equal(cardBytes(card).toString('utf8'), 'mpfy/card/1[1,"22de25661c578b57b919dfcada067bd4","d82c0f67c35fa61aff7e4eb051b36cd9758ca253d072f18d335218c86640b968","Bacca",null,1763380004000]')
  assert.equal(card.sig, 'f092ac36a3c08c8cbfe2a1465461a62c2561e6359df8a0b56fdd9c928b6a83a98a009de11205ef32754476b45695065768038129b858fccb86620b9e9f52470c')
  assert.equal(cardProblem(card), null)

  const now = Date.now()
  const b = makeProfile()
  const ok = makeCard(b, { name: 'Giulia', updatedAt: now - 10 })
  assert.equal(cardProblem(ok, now), null)
  assert.equal(cardProblem(makeCard(b, { name: 'Giulia', photo: 'ab'.repeat(32), updatedAt: now })), null, 'with a photo')
  const other = makeProfile()
  const cases = [
    [{ ...ok, profileId: other.id }, 'bad_card', 'the id of another key'],
    [{ ...ok, extra: 1 }, 'bad_card', 'nine keys'],
    [(({ photo, ...rest }) => rest)(ok), 'bad_card', 'seven keys'],
    [makeCard(b, { name: 'Giu\u0007lia', updatedAt: now }), 'bad_card', 'a control character in the name'],
    [makeCard(b, { name: ' Giulia', updatedAt: now }), 'bad_card', 'a name not as cleaned'],
    [makeCard(b, { name: 'x'.repeat(41), updatedAt: now }), 'bad_card', '41 characters'],
    [makeCard(b, { name: '', updatedAt: now }), 'bad_card', 'an empty name'],
    [makeCard(b, { name: 'Giulia', updatedAt: now + 6 * MIN }), 'bad_time', '6 minutes ahead'],
    [makeCard(b, { name: 'Giulia', updatedAt: 1.5 }), 'bad_time', 'not whole milliseconds'],
    [makeCard(b, { name: 'Giulia', updatedAt: 0 }), 'bad_time', 'not above 0'],
    [{ ...ok, sig: ok.sig.replace(/^./, ok.sig[0] === '0' ? '1' : '0') }, 'bad_card', 'a bad signature'],
    [{ ...ok, name: 'Giulio' }, 'bad_card', 'renamed after signing'],
    [{ ...ok, chatPublicKey: chatKeysOf(other.secret).publicKey.toString('hex') }, 'bad_card', 'another chat key'],
    [{ ...ok, v: 2 }, 'bad_card', 'another version'],
    [{ ...ok, photo: 'AB'.repeat(32) }, 'bad_card', 'upper-case hex'],
    [{ ...ok, chatPublicKey: 'zz' }, 'bad_card', 'a short key'],
    [null, 'bad_card', 'null'],
    [[ok], 'bad_card', 'an array']
  ]
  for (const [c, code, what] of cases) assert.equal(cardProblem(c, now), code, what)
  // Exactly 5 minutes ahead is still fine.
  assert.equal(cardProblem(makeCard(b, { name: 'Giulia', updatedAt: now + 5 * MIN }), now), null)

  assert.equal(cardWins(ok, null), true)
  const newer = makeCard(b, { name: 'Giulia', updatedAt: now })
  assert.equal(cardWins(newer, ok), true)
  assert.equal(cardWins(ok, newer), false)
})

test('card API: the caller\'s own only, newer replaces, older is kept and returned, equal time and greater signature wins', async (t) => {
  const { app } = await start(t)
  const p = makeProfile()
  const phone = device(app, { profile: p })
  const now = Date.now()
  const first = makeCard(p, { name: 'Bacca', updatedAt: now - 5000 })
  let r = await phone.call('PUT', '/api/profile/card', { body: first })
  assert.equal(r.status, 200, r.body.toString())
  assert.deepEqual(body(r), { card: first })
  assert.equal(body(await phone.call('GET', '/api/profile')).social.card, now - 5000)

  const newer = makeCard(p, { name: 'Bacca B.', updatedAt: now - 1000 })
  assert.deepEqual(body(await phone.call('PUT', '/api/profile/card', { body: newer })), { card: newer })
  r = await phone.call('PUT', '/api/profile/card', { body: first })
  assert.equal(r.status, 200)
  assert.deepEqual(body(r), { card: newer }, 'an older card: the stored one comes back')

  // Two cards of the same time: the greater signature wins, whichever comes first.
  let x = null
  let y = null
  for (let i = 0; ; i++) {
    x = makeCard(p, { name: 'Uno ' + i, updatedAt: now })
    y = makeCard(p, { name: 'Due ' + i, updatedAt: now })
    if (x.sig < y.sig) break
  }
  assert.deepEqual(body(await phone.call('PUT', '/api/profile/card', { body: x })), { card: x })
  assert.deepEqual(body(await phone.call('PUT', '/api/profile/card', { body: y })), { card: y })
  assert.deepEqual(body(await phone.call('PUT', '/api/profile/card', { body: x })), { card: y })

  const stranger = makeProfile()
  await expectCode(phone.call('PUT', '/api/profile/card', { body: makeCard(stranger, { name: 'Altro' }) }), 400, 'bad_card')
  await expectCode(phone.call('PUT', '/api/profile/card', { body: makeCard(p, { name: 'Bacca', updatedAt: Date.now() + 6 * MIN }) }), 400, 'bad_time')
  await expectCode(phone.call('PUT', '/api/profile/card', { body: { ...y, extra: true } }), 400, 'bad_card')
  assert.equal(app.social.card(stranger.id), null, 'nothing stored for the other profile')
  assert.deepEqual(app.social.card(p.id), y)
})

// --------------------------------------------------------------- settings

test('settings: each section replaced only by a newer one, shapes and times refused, GET for the caller only', async (t) => {
  const c = clock()
  const { app } = await start(t, { socialNow: c.now })
  const a = await person(app, 'Anna')
  const b = await person(app, 'Bruno')
  // Each write in a minute of its own (10 card or settings writes a minute at most).
  const put = (make) => {
    c.add(MIN)
    return a.call('PUT', '/api/profile/social', { body: make(c.now()) })
  }
  let r = await a.call('GET', '/api/profile/social')
  assert.equal(r.status, 200)
  assert.deepEqual(body(r), {
    privacy: { invisible: false, showNow: true, privateUntil: 0, showRecent: true, updatedAt: 0 },
    blocked: { ids: [], updatedAt: 0 },
    mutes: { box: null, updatedAt: 0 }
  })
  const now = c.now()
  const p10 = privacy({ showRecent: false, updatedAt: now - 10 })
  r = await put(() => ({ privacy: p10 }))
  assert.equal(r.status, 200, r.body.toString())
  assert.deepEqual(body(r).privacy, p10)
  r = await put(() => ({ privacy: privacy({ updatedAt: now - 20 }), blocked: { ids: [b.id], updatedAt: now - 30 } }))
  assert.deepEqual(body(r).privacy, p10, 'the older privacy is not taken')
  assert.deepEqual(body(r).blocked, { ids: [b.id], updatedAt: now - 30 }, 'the newer blocked list is')
  r = await put(() => ({ blocked: { ids: [], updatedAt: now - 30 } }))
  assert.deepEqual(body(r).blocked, { ids: [b.id], updatedAt: now - 30 }, 'the same time is not newer')
  const stamps = body(await a.call('GET', '/api/profile')).social
  assert.deepEqual(stamps, { v: 3, card: stamps.card, privacy: now - 10, blocked: now - 30, mutes: 0, access: 0 })
  assert.ok(stamps.card > 0)
  assert.deepEqual(body(await b.call('GET', '/api/profile/social')).blocked, { ids: [], updatedAt: 0 }, 'B never reads the settings of A')
  assert.deepEqual(body(await put(() => ({}))).privacy, p10, 'nothing sent: nothing changes')

  const shapes = [
    (t0) => ({ privacy: (({ showNow, ...rest }) => rest)(privacy({ updatedAt: t0 })) }),
    (t0) => ({ privacy: { ...privacy({ updatedAt: t0 }), extra: 1 } }),
    (t0) => ({ privacy: privacy({ invisible: 'yes', updatedAt: t0 }) }),
    (t0) => ({ privacy: privacy({ privateUntil: 'later', updatedAt: t0 }) }),
    (t0) => ({ privacy: privacy({ updatedAt: String(t0) }) }),
    () => ({ privacy: null }),
    () => ({ privacy: [] }),
    (t0) => ({ blocked: { ids: [a.id], updatedAt: t0 } }),
    (t0) => ({ blocked: { ids: [b.id, b.id], updatedAt: t0 } }),
    (t0) => ({ blocked: { ids: ['nope'], updatedAt: t0 } }),
    (t0) => ({ blocked: { ids: b.id, updatedAt: t0 } }),
    (t0) => ({ blocked: { ids: Array.from({ length: 10001 }, () => crypto.randomBytes(16).toString('hex')), updatedAt: t0 } }),
    (t0) => ({ mutes: { box: 'not base64!', updatedAt: t0 } }),
    (t0) => ({ mutes: { box: 5, updatedAt: t0 } }),
    (t0) => ({ mutes: { updatedAt: t0 } }),
    () => ({ other: {} })
  ]
  for (const make of shapes) await expectCode(put(make), 400, 'bad_request')
  const times = [
    (t0) => ({ privacy: privacy({ updatedAt: t0 + 6 * MIN }) }),
    () => ({ privacy: privacy({ updatedAt: 1.5 }) }),
    () => ({ privacy: privacy({ updatedAt: -1 }) }),
    (t0) => ({ privacy: privacy({ privateUntil: t0 + 7 * 3600 * 1000, updatedAt: t0 }) }),
    (t0) => ({ blocked: { ids: [], updatedAt: t0 + 6 * MIN } }),
    (t0) => ({ mutes: { box: null, updatedAt: t0 + 6 * MIN } })
  ]
  for (const make of times) await expectCode(put(make), 400, 'bad_time')
  // A wrong section refuses the whole request: the good one beside it is not kept.
  await expectCode(put((t0) => ({ privacy: privacy({ updatedAt: t0 }), blocked: { ids: [a.id], updatedAt: t0 } })), 400, 'bad_request')
  assert.deepEqual(body(await a.call('GET', '/api/profile/social')).privacy, p10)
  // A private session of 6 hours (plus the clocks) is fine; 0 and an end gone by too.
  for (const until of [(t0) => t0 + 6 * 3600 * 1000 + 4 * MIN, () => 0, () => 1000]) {
    let sent = null
    r = await put((t0) => {
      sent = privacy({ privateUntil: until(t0), updatedAt: t0 })
      return { privacy: sent }
    })
    assert.deepEqual(body(r).privacy, sent)
  }
  // Exactly 5 minutes ahead is still a time.
  r = await put((t0) => ({ blocked: { ids: [], updatedAt: t0 + 5 * MIN } }))
  assert.equal(r.status, 200)
})

test('mutes: an opaque box stored and returned as it came, never read; 64 KB plus one byte refused', async (t) => {
  const { app, dir } = await start(t)
  const a = await person(app, 'Anna')
  // Any bytes: the source never opens it.
  const box = crypto.randomBytes(5000).toString('base64')
  const at = Date.now()
  let r = await a.call('PUT', '/api/profile/social', { body: { mutes: { box, updatedAt: at } } })
  assert.equal(r.status, 200, r.body.toString())
  assert.deepEqual(body(r).mutes, { box, updatedAt: at })
  assert.deepEqual(body(await a.call('GET', '/api/profile/social')).mutes, { box, updatedAt: at })
  const full = crypto.randomBytes(MAX_MUTES_BYTES).toString('base64')
  r = await a.call('PUT', '/api/profile/social', { body: { mutes: { box: full, updatedAt: at + 1 } } })
  assert.equal(r.status, 200, '64 KB exactly')
  await expectCode(a.call('PUT', '/api/profile/social', { body: { mutes: { box: crypto.randomBytes(MAX_MUTES_BYTES + 1).toString('base64'), updatedAt: at + 2 } } }), 400, 'bad_request')
  r = await a.call('PUT', '/api/profile/social', { body: { mutes: { box: null, updatedAt: at + 3 } } })
  assert.deepEqual(body(r).mutes, { box: null, updatedAt: at + 3 })
  r = await a.call('PUT', '/api/profile/social', { body: { mutes: { box, updatedAt: at + 4 } } })
  app.social.flush()
  const file = JSON.parse(fs.readFileSync(path.join(dir, 'social', a.id + '.json'), 'utf8'))
  assert.deepEqual(file.mutes, { box, updatedAt: at + 4 }, 'kept in the file as sent')
})

// ---------------------------------------------------------------- activity

test('activity: now served only within 120 s, cleared by a pause; now: false keeps none; recent distinct, at most 20, artistPage kept', async (t) => {
  const c = clock()
  const { app } = await start(t, { socialNow: c.now })
  const a = await person(app, 'Anna')
  const b = await person(app, 'Bruno')
  const anna = async () => (await list(b)).people.find((x) => x.profileId === a.id)

  assert.deepEqual(await anna(), { profileId: a.id, card: app.social.card(a.id), seen: 'all', now: null, last: null })
  let r = await report(a, track(1, { artistPage: true }))
  assert.equal(r.status, 200, r.body.toString())
  assert.deepEqual(body(r), { ok: true })
  let seen = await anna()
  const at1 = seen.now.at
  assert.deepEqual(seen.now, { trackId: T(1), title: 'Brano 1', artist: 'Lumen Marino', album: 'Ultimo traghetto', at: at1 })
  assert.deepEqual(seen.last, { trackId: T(1), title: 'Brano 1', artist: 'Lumen Marino', album: 'Ultimo traghetto', artistPage: true, at: at1 })
  c.add(120 * 1000)
  assert.ok((await anna()).now !== null, 'exactly 120 s: still now')
  c.add(1)
  seen = await anna()
  assert.equal(seen.now, null, 'past 120 s: no longer now')
  assert.equal(seen.last.trackId, T(1), 'the last play stays')

  await report(a, track(2))
  assert.equal((await anna()).now.trackId, T(2))
  await report(a, track(2), { playing: false })
  seen = await anna()
  assert.equal(seen.now, null, 'a pause clears it')
  assert.equal(seen.last.trackId, T(2))
  await report(a, track(3), { now: false })
  seen = await anna()
  assert.equal(seen.now, null, 'now: false keeps none')
  assert.equal(seen.last.trackId, T(3), 'the play is still a recent one')
  await report(a, track(4), { recent: false })
  seen = await anna()
  assert.equal(seen.now.trackId, T(4))
  assert.equal(seen.last.trackId, T(3), 'recent: false keeps it out of the recent plays')
  await report(a, null, { playing: false })
  assert.equal((await anna()).now, null)

  // A heartbeat of the same track moves it to the front, once (12 reports a minute at most).
  c.add(MIN)
  for (let i = 5; i < 30; i++) {
    c.add(5000)
    await report(a, track(i))
  }
  c.add(5000)
  await report(a, track(10))
  c.add(61 * 1000) // a new minute for the reports
  r = await b.call('GET', '/api/people/' + a.id)
  assert.equal(r.status, 200)
  const page = body(r)
  assert.equal(page.recent.length, 20)
  assert.equal(page.recent[0].trackId, T(10))
  assert.deepEqual(page.recent.map((x) => x.trackId), [T(10), ...[29, 28, 27, 26, 25, 24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11].map(T)])
  assert.equal(new Set(page.recent.map((x) => x.trackId)).size, 20, 'distinct')
  for (let i = 1; i < page.recent.length; i++) assert.ok(page.recent[i - 1].at >= page.recent[i].at, 'newest first')
  assert.deepEqual(page.person.last, page.recent[0])

  // The texts are cleaned and counted in code points.
  r = await report(a, track(40, { title: ' Lascio\nil  molo\u0001al buio ', artist: 'x'.repeat(200), album: '\u{1F30A}'.repeat(200) }))
  assert.equal(r.status, 200, r.body.toString())
  assert.equal((await anna()).now.title, 'Lascio il molo al buio')
  const bad = [
    { track: track(1), playing: true, now: true },
    { track: track(1), playing: 'yes', now: true, recent: true },
    { track: { ...track(1), trackId: 'abc' }, playing: true, now: true, recent: true },
    { track: { ...track(1), title: '   ' }, playing: true, now: true, recent: true },
    { track: { ...track(1), title: 'x'.repeat(201) }, playing: true, now: true, recent: true },
    { track: { ...track(1), artist: undefined }, playing: true, now: true, recent: true },
    { track: { ...track(1), artistPage: 'no' }, playing: true, now: true, recent: true },
    { track: { ...track(1), extra: 1 }, playing: true, now: true, recent: true },
    { track: track(1), playing: true, now: true, recent: true, more: 1 }
  ]
  for (const x of bad) await expectCode(a.call('PUT', '/api/activity', { body: x }), 400, 'bad_request')
})

test('activity: nothing kept while invisible or private; a privacy change clears now at once, showRecent off empties recent', async (t) => {
  const c = clock()
  const { app } = await start(t, { socialNow: c.now })
  const a = await person(app, 'Anna')
  const b = await person(app, 'Bruno')
  const setPrivacy = async (fields) => {
    const r = await a.call('PUT', '/api/profile/social', { body: { privacy: privacy({ ...fields, updatedAt: c.now() }) } })
    assert.equal(r.status, 200, r.body.toString())
    c.add(1)
  }
  const anna = async () => (await list(b)).people.find((x) => x.profileId === a.id)
  await report(a, track(1))
  assert.equal((await anna()).now.trackId, T(1))
  await setPrivacy({ showNow: false })
  let seen = await anna()
  assert.equal(seen.now, null, 'showNow off clears it')
  assert.equal(seen.last.trackId, T(1))
  assert.equal(app.social._playing.has(a.id), false, 'gone from memory, not only hidden')

  await setPrivacy({})
  await report(a, track(2))
  await setPrivacy({ privateUntil: c.now() + 3600 * 1000 })
  assert.equal(app.social._playing.has(a.id), false, 'a private session clears it')
  seen = await anna()
  assert.deepEqual([seen.now, seen.last], [null, null], 'a private session hides both')
  await report(a, track(3))
  assert.equal(app.social._playing.has(a.id), false, 'nothing kept while private')
  c.add(3600 * 1000)
  seen = await anna()
  assert.equal(seen.last.trackId, T(2), 'after the session the earlier plays show again, not what came during it')

  await setPrivacy({})
  await report(a, track(4))
  await setPrivacy({ invisible: true })
  assert.equal(app.social._playing.has(a.id), false, 'invisible clears it')
  await report(a, track(5))
  assert.equal(app.social._playing.has(a.id), false, 'nothing kept while invisible')
  await setPrivacy({})
  seen = await anna()
  assert.equal(seen.last.trackId, T(4))

  await setPrivacy({ showRecent: false })
  seen = await anna()
  assert.equal(seen.last, null)
  await setPrivacy({})
  seen = await anna()
  assert.equal(seen.last, null, 'emptied, not hidden: turned on again it shows nothing old')
  assert.deepEqual(body(await b.call('GET', '/api/people/' + a.id)).recent, [])
})

test('limits: the 13th report of a minute and the 11th card or settings write are 429 slow_down with retryAt, nothing stored', async (t) => {
  const c = clock()
  const { app } = await start(t, { socialNow: c.now })
  assert.deepEqual(RATE_LIMITS, { chat: 60, comment: 20, activity: 12, card: 10 })
  const a = await person(app, 'Anna') // its card is the first write
  const b = await person(app, 'Bruno')
  const t0 = c.now()
  for (let i = 1; i <= 12; i++) assert.equal((await report(a, track(i))).status, 200, 'report ' + i)
  const refused = await expectCode(report(a, track(13)), 429, 'slow_down')
  assert.equal(refused.error, 'Troppe richieste, riprova tra poco')
  assert.ok(refused.retryAt >= t0 + MIN && refused.retryAt <= c.now() + MIN, 'retryAt: when the oldest leaves the minute')
  const anna = (await list(b)).people.find((x) => x.profileId === a.id)
  assert.equal(anna.now.trackId, T(12), 'the refused report changed nothing')
  assert.equal((await report(b, track(1))).status, 200, 'another profile has its own minute')
  c.add(MIN)
  assert.equal((await report(a, track(14))).status, 200, 'a minute later')

  for (let i = 1; i <= 10; i++) {
    const r = i % 2 === 0
      ? await a.call('PUT', '/api/profile/social', { body: { privacy: privacy({ updatedAt: c.now() - 100 + i }) } })
      : await a.call('PUT', '/api/profile/card', { body: makeCard(a.profile, { name: 'Anna', updatedAt: c.now() - 100 + i }) })
    assert.equal(r.status, 200, 'write ' + i + ': ' + r.body.toString())
  }
  const before = body(await a.call('GET', '/api/profile/social')).privacy
  await expectCode(a.call('PUT', '/api/profile/social', { body: { privacy: privacy({ invisible: true, updatedAt: c.now() }) } }), 429, 'slow_down')
  await expectCode(a.call('PUT', '/api/profile/card', { body: makeCard(a.profile, { name: 'Altra', updatedAt: c.now() }) }), 429, 'slow_down')
  assert.deepEqual(body(await a.call('GET', '/api/profile/social')).privacy, before, 'nothing stored')
  assert.equal(app.social.card(a.id).name, 'Anna')
  app.social.sweep()
  c.add(MIN)
  app.social.sweep()
  assert.equal(app.social._hits.size, 0, 'old minutes are forgotten')
})

// -------------------------------------------------------------- who sees what

test('who sees whom: invisible absent everywhere, own page as a neutral member, owner as a member, removed and cardless absent, ETag 304', async (t) => {
  const { app } = await start(t)
  const owner = await person(app, 'Bacca')
  app.people.setOwner(owner.id, false)
  const a = await person(app, 'Anna')
  const b = await person(app, 'Bruno')
  const cardless = await person(app, 'Senza', { card: false })
  assert.equal(body(await owner.call('GET', '/api/profile')).role, 'owner')

  let seen = await list(a)
  assert.ok(Math.abs(seen.time - Date.now()) < 5000, 'time is the source clock')
  assert.deepEqual(seen.people.map((x) => x.profileId).sort(), [owner.id, b.id].sort(), 'the caller never, a profile without a card never')
  assert.deepEqual(seen.people.find((x) => x.profileId === b.id).card, app.social.card(b.id))
  assert.ok(!(await list(cardless)).people.some((x) => x.profileId === cardless.id))
  assert.equal((await list(cardless)).people.length, 3, 'without a card of its own it still sees the others')
  // The owner sees what a member sees: itself left out, nothing more.
  assert.deepEqual((await list(owner)).people.map((x) => x.profileId).sort(), [a.id, b.id].sort())
  await expectCode(a.call('GET', '/api/people/' + cardless.id), 404, 'no_person')
  await expectCode(a.call('GET', '/api/people/nope'), 404, 'no_person')
  await expectCode(a.call('GET', '/api/people/' + crypto.randomBytes(16).toString('hex')), 404, 'no_person')

  // ETag over the body without its time.
  let r = await a.call('GET', '/api/people')
  const tag = r.headers.etag
  assert.match(tag, /^"p[0-9a-f]{16}"$/)
  r = await a.call('GET', '/api/people', { headers: { 'if-none-match': tag } })
  assert.equal(r.status, 304)
  assert.equal(r.body.length, 0)
  await report(b, track(1))
  r = await a.call('GET', '/api/people', { headers: { 'if-none-match': tag } })
  assert.equal(r.status, 200, 'something changed')
  assert.notEqual(r.headers.etag, tag)
  const page = await a.call('GET', '/api/people/' + b.id)
  assert.match(page.headers.etag, /^"p[0-9a-f]{16}"$/)
  assert.equal((await a.call('GET', '/api/people/' + b.id, { headers: { 'if-none-match': page.headers.etag } })).status, 304)

  // B's photo: served while B is listed, the very bytes of the card's photo.
  const photo = fakeJpeg(7)
  r = await b.call('PUT', '/api/profile/photo', { body: { photo: photo.toString('base64'), photoUpdatedAt: Date.now() } })
  assert.equal(r.status, 200)
  assert.equal((await a.call('GET', '/api/people/' + b.id + '/photo')).status, 404, 'the card does not name it yet')
  await b.call('PUT', '/api/profile/card', { body: makeCard(b.profile, { name: 'Bruno', photo: sha(photo), updatedAt: Date.now() }) })
  r = await a.call('GET', '/api/people/' + b.id + '/photo')
  assert.equal(r.status, 200)
  assert.equal(r.headers['content-type'], 'image/jpeg')
  assert.equal(r.headers.etag, '"' + sha(photo) + '"')
  assert.ok(r.body.equals(photo))
  assert.equal((await a.call('GET', '/api/people/' + b.id + '/photo', { headers: { 'if-none-match': r.headers.etag } })).status, 304)
  assert.equal((await owner.call('GET', '/api/people/' + b.id + '/photo')).status, 200)

  // Own page: what a member with no block gets.
  await report(b, track(2))
  const own = body(await b.call('GET', '/api/people/' + b.id))
  const fromA = body(await a.call('GET', '/api/people/' + b.id))
  assert.deepEqual({ ...own, time: 0 }, { ...fromA, time: 0 })
  assert.equal(own.person.now.trackId, T(2))

  // Invisible: no list, no page, no photo, for anyone; its own page 404 too.
  r = await b.call('PUT', '/api/profile/social', { body: { privacy: privacy({ invisible: true }) } })
  assert.equal(r.status, 200)
  for (const viewer of [a, owner, cardless]) {
    assert.ok(!(await list(viewer)).people.some((x) => x.profileId === b.id))
    await expectCode(viewer.call('GET', '/api/people/' + b.id), 404, 'no_person')
    const ph = await viewer.call('GET', '/api/people/' + b.id + '/photo')
    assert.equal(ph.status, 404)
    assert.equal(body(ph).error, 'Foto non trovata')
  }
  await expectCode(b.call('GET', '/api/people/' + b.id), 404, 'no_person')
  assert.equal((await list(b)).people.length, 2, 'an invisible person still sees everyone (with a card)')
  await b.call('PUT', '/api/profile/social', { body: { privacy: privacy({ invisible: false, updatedAt: Date.now() + 1 }) } })
  assert.ok((await list(a)).people.some((x) => x.profileId === b.id), 'visible again')

  // Removed: gone from every list and page, and its record with it.
  app.people.removeProfile(a.id)
  assert.equal(app.social.card(a.id), null)
  assert.ok(!(await list(b)).people.some((x) => x.profileId === a.id))
  await expectCode(b.call('GET', '/api/people/' + a.id), 404, 'no_person')
})

test('blocks hide what is playing and the recent plays both ways, never the name, the photo or the page', async (t) => {
  const { app } = await start(t)
  const a = await person(app, 'Anna')
  const b = await person(app, 'Bruno')
  const c = await person(app, 'Carla')
  await report(a, track(1))
  await report(b, track(2))
  const r = await a.call('PUT', '/api/profile/social', { body: { blocked: { ids: [b.id], updatedAt: Date.now() } } })
  assert.equal(r.status, 200)
  const ofA = (await list(b)).people.find((x) => x.profileId === a.id)
  assert.deepEqual([ofA.now, ofA.last], [null, null], 'B, blocked by A, sees A without activity')
  assert.equal(ofA.card.name, 'Anna')
  const ofB = (await list(a)).people.find((x) => x.profileId === b.id)
  assert.deepEqual([ofB.now, ofB.last], [null, null], 'A, who blocked B, sees B without activity')
  const page = body(await b.call('GET', '/api/people/' + a.id))
  assert.deepEqual([page.person.now, page.recent], [null, []], 'the page answers, empty')
  assert.equal((await list(c)).people.find((x) => x.profileId === a.id).now.trackId, T(1), 'others still see it')
  assert.equal(body(await a.call('GET', '/api/people/' + a.id)).person.now.trackId, T(1), 'own page: as a member with no block')
})

test('no profile: local requests, an older app of the owner and a guest get 403 no_profile on every social route', async (t) => {
  const { app, port } = await start(t)
  const p = makeProfile()
  const routes = [
    ['PUT', '/api/profile/card', makeCard(p, { name: 'X' })],
    ['GET', '/api/profile/social'],
    ['PUT', '/api/profile/social', {}],
    ['PUT', '/api/activity', { track: null, playing: false, now: true, recent: true }],
    ['GET', '/api/people'],
    ['GET', '/api/people/' + p.id],
    ['GET', '/api/people/' + p.id + '/photo'],
    ['GET', '/api/chat/conversations'],
    ['GET', '/api/chat/group'],
    ['PUT', '/api/chat/group/access', { at: 1, sig: '00'.repeat(64) }],
    ['GET', '/api/chat/' + '00'.repeat(16) + '/messages'],
    ['POST', '/api/chat/' + '00'.repeat(16) + '/messages', {}],
    ['DELETE', '/api/chat/' + '00'.repeat(16) + '/messages/' + '11'.repeat(16)],
    ['GET', '/api/chat/' + '00'.repeat(16) + '/messages/' + '11'.repeat(16) + '/playlist'],
    ['PUT', '/api/chat/' + '00'.repeat(16) + '/read', { at: 1, id: '11'.repeat(16) }]
  ]
  const legacy = device(app, { legacy: true })
  const guest = device(app)
  for (const [method, url, b] of routes) {
    await expectCode(request(port, method, url, { body: b || null }), 403, 'no_profile')
    await expectCode(legacy.call(method, url, { body: b || null }), 403, 'no_profile')
    await expectCode(guest.call(method, url, { body: b || null }), 403, 'no_profile')
  }
  await expectCode(guest.call('GET', '/api/recents'), 403, 'no_profile')
  // GET /api/profile still answers them, with the stamps at 0.
  const prof = json(await request(port, 'GET', '/api/profile'))
  assert.deepEqual(prof.social, { v: 3, card: 0, privacy: 0, blocked: 0, mutes: 0, access: 0 })
  assert.equal(json(await request(port, 'GET', '/api/health')).social, 3)
  assert.equal(json(await request(port, 'GET', '/api/library')).source.social, 3)
})

// ------------------------------------------------------------- the file

test('social files: one per person, written within 2 s of a card or settings change, at most once a minute for heartbeats alone; kept across a restart', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  const plain = new SocialStore({ dataDir: dir })
  assert.equal(plain.cardDelayMs, 2000)
  assert.equal(plain.recentDelayMs, 60000)
  plain.close()

  const store = new SocialStore({ dataDir: dir, cardDelayMs: 30, recentDelayMs: 1000 })
  t.after(() => store.close())
  const p = makeProfile()
  const beat = (n) => store.activity(p.id, { track: track(n), playing: true, now: true, recent: true })
  const started = Date.now()
  beat(1)
  while (Date.now() - started < 2500) {
    beat(1 + (Math.floor((Date.now() - started) / 100) % 3))
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  // Heartbeats for 2.5 s with a 1 s wait: the first write a second after the first
  // beat, then one a second at most.
  assert.ok(store.writes >= 1 && store.writes <= Math.ceil((Date.now() - started) / 1000), 'writes: ' + store.writes)
  const w = store.writes
  const put = Date.now()
  store.putCard(p.id, makeCard(p, { name: 'Anna' }))
  await waitFor(() => store.writes === w + 1, { timeout: 3000, what: 'the card write' })
  assert.ok(Date.now() - put < 900, 'the card does not wait for the heartbeats\' second')

  // A change of one person writes that person's file and no other.
  const q = makeProfile()
  store.putCard(q.id, makeCard(q, { name: 'Bruno' }))
  await waitFor(() => fs.existsSync(store.fileOf(q.id)), { timeout: 3000, what: 'the second file' })
  const before = fs.readFileSync(store.fileOf(p.id), 'utf8')
  const w2 = store.writes
  store.putSettings(q.id, { blocked: { ids: [p.id], updatedAt: Date.now() } })
  await waitFor(() => store.writes === w2 + 1, { timeout: 3000, what: 'the settings write' })
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(store.writes, w2 + 1, 'one file written')
  assert.equal(fs.readFileSync(store.fileOf(p.id), 'utf8'), before, 'the other person\'s file untouched')
  assert.deepEqual(JSON.parse(fs.readFileSync(store.fileOf(q.id), 'utf8')).blocked.ids, [p.id])
  assert.ok(!fs.existsSync(path.join(dir, 'social.json')), 'no file for everyone')
  store.close()

  const again = new SocialStore({ dataDir: dir })
  t.after(() => again.close())
  assert.equal(again.card(p.id).name, 'Anna')
  assert.equal(again.card(q.id).name, 'Bruno')
  assert.equal(again._records.get(p.id).recent.length, 3)
  assert.equal(fs.statSync(again.fileOf(p.id)).mode & 0o777 & (process.platform === 'win32' ? 0 : 0o077), 0, '0600')
  assert.equal(fs.statSync(path.join(dir, 'social')).mode & 0o777 & (process.platform === 'win32' ? 0 : 0o077), 0, 'the folder 0700')
})

test('social files: unknown fields kept; a file that does not parse is set aside and that person begins again', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  const p = makeProfile()
  const q = makeProfile()
  const card = makeCard(p, { name: 'Anna', updatedAt: 1000 })
  fs.mkdirSync(path.join(dir, 'social'))
  fs.writeFileSync(path.join(dir, 'social', p.id + '.json'), JSON.stringify({ schema: 1, card, chats: [1, 2], privacy: { showNow: false, updatedAt: 5 } }))
  fs.writeFileSync(path.join(dir, 'social', q.id + '.json'), JSON.stringify({ schema: 1, card: makeCard(q, { name: 'Bruno', updatedAt: 1000 }) }))
  let store = new SocialStore({ dataDir: dir, cardDelayMs: 10 })
  assert.equal(store.card(p.id).name, 'Anna')
  assert.equal(store.settings(p.id).privacy.showNow, false)
  store.putSettings(p.id, { blocked: { ids: [], updatedAt: 9 } })
  store.close()
  const file = JSON.parse(fs.readFileSync(path.join(dir, 'social', p.id + '.json'), 'utf8'))
  assert.deepEqual(file.chats, [1, 2])
  assert.equal(file.blocked.updatedAt, 9)

  for (const bad of ['{ not json', '[]', '']) {
    fs.writeFileSync(path.join(dir, 'social', p.id + '.json'), bad)
    store = new SocialStore({ dataDir: dir, cardDelayMs: 10 })
    assert.equal(store.card(p.id), null, 'that person begins again')
    assert.equal(store.card(q.id).name, 'Bruno', 'nobody else does')
    store.putCard(p.id, card)
    store.close()
    const aside = fs.readdirSync(path.join(dir, 'social')).filter((n) => n.startsWith(p.id + '.json.corrupt-'))
    assert.equal(aside.length, 1, 'set aside')
    assert.equal(fs.readFileSync(path.join(dir, 'social', aside[0]), 'utf8'), bad)
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'social', p.id + '.json'), 'utf8')).card.name, 'Anna')
    fs.unlinkSync(path.join(dir, 'social', aside[0]))
  }

  // Through the whole source: it starts, and the people part works.
  fs.writeFileSync(path.join(dir, 'social', q.id + '.json'), '{{{')
  const { app } = await start(t, { dir })
  const a = await person(app, 'Anna')
  assert.equal(app.social.card(a.id).name, 'Anna')
  assert.ok(fs.readdirSync(path.join(dir, 'social')).some((n) => n.startsWith(q.id + '.json.corrupt-')))
})

test('social.json of an older source: split into one file per person with nothing lost, then set aside; a social.json that does not parse is set aside', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  const p = makeProfile()
  const q = makeProfile()
  const old = {
    schema: 1,
    later: { x: 1 },
    profiles: {
      [p.id]: {
        card: makeCard(p, { name: 'Anna', updatedAt: 1000 }),
        chats: [1, 2],
        privacy: { invisible: true, showNow: false, privateUntil: 0, showRecent: true, updatedAt: 5 },
        blocked: { ids: [q.id], updatedAt: 6 },
        mutes: { box: 'AAAA', updatedAt: 7 },
        recent: [{ trackId: T(1), title: 'Brano 1', artist: 'Lumen Marino', album: 'Ultimo traghetto', artistPage: true, at: 900 }]
      },
      [q.id]: { card: makeCard(q, { name: 'Bruno', updatedAt: 2000 }) }
    }
  }
  const text = JSON.stringify(old)
  fs.writeFileSync(path.join(dir, 'social.json'), text)
  const store = new SocialStore({ dataDir: dir })
  assert.ok(!fs.existsSync(path.join(dir, 'social.json')), 'the old file is no longer read')
  const aside = fs.readdirSync(dir).filter((n) => /^social\.json\.migrated-\d+$/.test(n))
  assert.equal(aside.length, 1)
  assert.equal(fs.readFileSync(path.join(dir, aside[0]), 'utf8'), text, 'kept whole')
  for (const [pid, r] of Object.entries(old.profiles)) {
    const file = JSON.parse(fs.readFileSync(store.fileOf(pid), 'utf8'))
    assert.deepEqual(file.card, r.card)
    if (pid === p.id) {
      assert.deepEqual(file.chats, [1, 2], 'unknown fields kept')
      assert.deepEqual(file.privacy, r.privacy)
      assert.deepEqual(file.blocked, r.blocked)
      assert.deepEqual(file.mutes, r.mutes)
      assert.deepEqual(file.recent, r.recent)
    }
  }
  assert.equal(store.settings(p.id).privacy.invisible, true)
  store.close()
  // The next start reads the files only.
  const again = new SocialStore({ dataDir: dir })
  assert.equal(again.card(q.id).name, 'Bruno')
  assert.deepEqual(again.settings(p.id).blocked, { ids: [q.id], updatedAt: 6 })
  again.close()

  const dir2 = cleanup(t).dir(tmpDir())
  fs.writeFileSync(path.join(dir2, 'social.json'), '{ not json')
  const fresh = new SocialStore({ dataDir: dir2 })
  assert.equal(fresh.card(p.id), null)
  assert.ok(fs.readdirSync(dir2).some((n) => /^social\.json\.corrupt-\d+$/.test(n)))
  assert.ok(!fs.existsSync(path.join(dir2, 'social.json')))
  fresh.close()
})

test('a profile removed with the source stopped loses its social file at the next start', async (t) => {
  const { app, dir } = await start(t, { socialDelays: { cardDelayMs: 10 } })
  const a = await person(app, 'Anna')
  const b = await person(app, 'Bruno')
  await app.close()
  assert.ok(fs.existsSync(path.join(dir, 'social', a.id + '.json')))
  // What the CLI does with the source stopped.
  const profiles = JSON.parse(fs.readFileSync(path.join(dir, 'profiles.json'), 'utf8'))
  profiles.profiles.find((x) => x.profileId === a.id).removedAt = Date.now()
  fs.writeFileSync(path.join(dir, 'profiles.json'), JSON.stringify(profiles))
  const { app: again } = await start(t, { dir, socialDelays: { cardDelayMs: 10 } })
  assert.equal(again.social.card(a.id), null)
  assert.equal(again.social.card(b.id).name, 'Bruno')
  again.social.flush()
  assert.ok(!fs.existsSync(path.join(dir, 'social', a.id + '.json')))
  assert.ok(fs.existsSync(path.join(dir, 'social', b.id + '.json')))
})

// ------------------------------------------------------------- Recenti

test('recenti: 1,001 plays keep 1,000, the library still 50, pages with before, limit and more, never another profile\'s', async (t) => {
  const { app, port } = await start(t)
  const a = await person(app, 'Anna', { card: false })
  const b = await person(app, 'Bruno', { card: false })
  const user = app.users.get(a.id)
  const base = Date.now() - 10 * 24 * 3600 * 1000
  for (let i = 0; i < 1001; i++) user.played(T(1 + (i % 7)), { type: 'album', id: 'a' + (i % 3) }, base + i * 1000)
  assert.equal(MAX_HISTORY, 1000)
  assert.equal(user.recents.length, 1000)
  assert.equal(user.recents[999].at, base + 1000, 'the oldest went')
  assert.equal(json(await a.call('GET', '/api/library')).recents.length, 50)

  let r = json(await a.call('GET', '/api/recents'))
  assert.equal(r.recents.length, 100)
  assert.equal(r.more, true)
  assert.deepEqual(r.recents[0], { trackId: T(1 + (1000 % 7)), at: base + 1000 * 1000, context: { type: 'album', id: 'a' + (1000 % 3) } })
  const seen = [...r.recents]
  while (r.more) {
    r = json(await a.call('GET', '/api/recents?before=' + seen[seen.length - 1].at + '&limit=200'))
    assert.ok(r.recents.length <= 200)
    seen.push(...r.recents)
  }
  assert.equal(seen.length, 1000)
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i - 1].at > seen[i].at)
  r = json(await a.call('GET', '/api/recents?limit=5000'))
  assert.equal(r.recents.length, 200, 'at most 200')
  r = json(await a.call('GET', '/api/recents?before=' + (base + 1001)))
  assert.deepEqual(r, { recents: [{ trackId: T(1 + (1 % 7)), at: base + 1000, context: { type: 'album', id: 'a1' } }], more: false })
  r = json(await a.call('GET', '/api/recents?before=' + base))
  assert.deepEqual(r, { recents: [], more: false })
  for (const q of ['limit=0', 'limit=-1', 'limit=abc', 'before=x', 'before=1.5']) {
    await expectCode(a.call('GET', '/api/recents?' + q), 400, 'bad_request')
  }
  assert.deepEqual(json(await b.call('GET', '/api/recents')), { recents: [], more: false }, 'Bruno never reads Anna\'s plays')
  // The owner acting from the source itself reads the owner's own data, as the library does.
  assert.equal((await request(port, 'GET', '/api/recents')).status, 200)
})

test('recenti: the merge of two people\'s data cuts at 1,000', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  const users = new Users({ dataDir: dir, debounceMs: 10 })
  users.load()
  t.after(() => users.close())
  const a = makeProfile().id
  const b = makeProfile().id
  const base = Date.now() - 20 * 24 * 3600 * 1000
  for (let i = 0; i < 700; i++) users.get(a).played(T(1), null, base + i * 2000)
  for (let i = 0; i < 700; i++) users.get(b).played(T(2), null, base + i * 2000 + 1000)
  await users.merge(a, b)
  const merged = users.get(b).recents
  assert.equal(merged.length, 1000)
  for (let i = 1; i < merged.length; i++) assert.ok(merged[i - 1].at >= merged[i].at)
  assert.equal(merged[0].at, base + 699 * 2000 + 1000)
  users.close()
  const again = new Users({ dataDir: dir })
  again.load()
  assert.equal(again.get(b).recents.length, 1000, 'kept in the file')
  assert.equal(again.get(b).snapshot().recents.length, 50)
})
