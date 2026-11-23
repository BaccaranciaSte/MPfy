// The details and lyrics of the phone's own songs, found by the phone itself
// (client-core/phone-lookups.js) through the host's transport: the requests it
// sends (exactly the source's URLs, nothing about the person or the files), what
// it writes from recorded answers, the pacing, the back-off, the pause without a
// network and on a metered one, the switch, the songs a real source already holds.
// The services are answered by the test; every lyric line in here is invented.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { PhoneSource, PHONE_ID } from '../client-core/phone.js'
import { searchQuery, hintsOf, chooseRelease, valuesOf } from '../server/details.mjs'
import { tmpDir, cleanup, waitFor } from './helpers.mjs'

const read = (rel) => JSON.parse(fs.readFileSync(new URL(rel, import.meta.url), 'utf8'))
const AIZO = read('./fixtures/details/mb-recording-aizo.json')
const LINES = ['Lascio il molo al buio', 'Il vento sa il mio nome']
const PROFILE = 'cd'.repeat(16)
const FAST = { fillDelayMs: 10, pace: { musicbrainz: 5, caa: 5 }, lyricsPaceMs: 5, offlinePause: [150, 300], backoff: [40, 80], lyricsBackoff: [40, 80] }
const idOf = (n) => n.toString(16).padStart(24, '0')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

class FakeHost {
  constructor () {
    this.homeId = PHONE_ID
    this.sources = []
  }

  profileId () { return PROFILE }
  realSources () { return this.sources }
  home () { return this.homeId }
  forward () {}
  send (conn, status, headers, body) { conn.res = { status, headers, body } }
  json (conn, status, obj, headers = {}) { conn.res = { status, headers, data: obj } }
  async pieces (conn, status, headers, pieces) {
    let text = ''
    for (const p of pieces) text += p
    conn.res = { status, headers, data: JSON.parse(text) }
  }

  readBody (conn, req, rest) { return Promise.resolve(rest) }
  log () {}
}

const opened = new Set()
test.afterEach(async () => {
  for (const p of [...opened]) await p.stop()
  opened.clear()
})

// A phone whose network requests the test answers: `answer(msg)` gives the reply,
// or null to give none (the request waits).
function open (t, answer, { dir = null, host = new FakeHost(), lookups = FAST } = {}) {
  const base = dir || path.join(cleanup(t).dir(tmpDir('mpfy-lookups-')), 'p')
  const sent = []
  let phone = null
  const send = (m) => {
    sent.push(m)
    if (m.t !== 'net') return
    setImmediate(() => {
      const r = answer(m)
      if (r !== null && r !== undefined) phone.message({ t: 'net-reply', id: m.id, ...r })
    })
  }
  phone = new PhoneSource({ dir: base, send, host, lookups })
  opened.add(phone)
  phone.start()
  return { phone, sent, host, dir: base, nets: () => sent.filter((m) => m.t === 'net') }
}

async function feed (phone, ...msgs) {
  for (const m of msgs) phone.message({ t: 'local', ...m })
  await phone.settled()
}

async function put (phone, list) {
  await feed(phone, { op: 'reset', token: 'k' }, { op: 'put', token: 'k', batch: 1, tracks: list }, { op: 'end', token: 'k', batch: 2 })
}

function facts (n, extra = {}) {
  return {
    id: idOf(n),
    name: 'Canzone ' + n + '.mp3',
    size: 4000000 + n,
    mtime: 1763380000000,
    addedAt: 1763380000000 + n,
    tags: { title: null, artist: null, album: null, albumArtist: null, trackNo: null, discNo: null, year: null },
    format: 'mp3',
    codec: 'audio/mpeg',
    duration: 215.9,
    bitrate: 320000,
    sampleRate: 44100,
    bitDepth: null,
    coverId: null,
    lyrics: { synced: [], texts: [], lrc: null },
    was: [],
    ...extra
  }
}

// A song whose file has no tags, named "King Gnu - AIZO.mp3".
const aizo = (n = 1) => facts(n, { name: 'King Gnu - AIZO.mp3' })
const jpeg = (s) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(s), Buffer.from([0xff, 0xd9])]).toString('base64')
const COVER = { coverId: 'e'.repeat(24), small: jpeg('small'), large: jpeg('large') }
const searchAnswer = (extra = []) => ({ recordings: [{ id: AIZO.id, score: 100, title: 'AIZO', length: 215858, 'artist-credit': [{ name: 'King Gnu' }] }, ...extra] })

// The services as the recorded answers give them.
function services ({ lrclib = () => ({ status: 404 }), search = () => ({ status: 200, json: searchAnswer() }) } = {}) {
  return (m) => {
    if (m.service === 'musicbrainz' && m.url.includes('/ws/2/recording?query=')) return search(m)
    if (m.service === 'musicbrainz' && m.url.includes('/ws/2/recording/' + AIZO.id)) return { status: 200, json: JSON.stringify(AIZO) }
    if (m.service === 'caa') return { status: 200, cover: COVER }
    if (m.service === 'lrclib') return lrclib(m)
    return { status: 404 }
  }
}

async function ask (phone, target) {
  const conn = {}
  await phone.handle(conn, { method: 'GET', map: {} }, target, Buffer.alloc(0))
  return conn.res
}

const stored = (phone, n) => phone.trackOf(idOf(n))

// Every request: the five fields, a service's own prefix, only the source's
// parameters; never the file's name, a path, the profile.
function checkRequests (nets) {
  const prefixes = { musicbrainz: 'https://musicbrainz.org/ws/2/', caa: 'https://coverartarchive.org/', lrclib: 'https://lrclib.net/api/get?' }
  const params = { musicbrainz: ['query', 'fmt', 'limit', 'inc', 'recording', 'status', 'offset'], lrclib: ['track_name', 'artist_name', 'album_name', 'duration'], caa: [] }
  for (const m of nets) {
    assert.deepEqual(Object.keys(m), ['t', 'id', 'service', 'url', 'kind'], JSON.stringify(m))
    assert.ok(m.url.startsWith(prefixes[m.service]), m.url)
    assert.equal(m.kind, m.service === 'caa' ? 'cover' : 'json')
    const q = m.url.indexOf('?')
    const names = q === -1 ? [] : m.url.slice(q + 1).split('&').map((p) => p.split('=')[0])
    for (const n of names) assert.ok(params[m.service].includes(n), m.service + ' parameter ' + n)
    assert.doesNotMatch(decodeURIComponent(m.url.replace(/\+/g, ' ')), /\.mp3|Canzone|\/storage|Download|cdcdcd/i, m.url)
  }
}

// ------------------------------------------------------------------- the details

test('a song without tags: the text search finds it, then its recording, release and cover; LRCLIB then asked with the found title and artist; exactly the source\'s requests', async (t) => {
  const lrc = '[00:01.00]' + LINES[0] + '\n[00:03.00]' + LINES[1]
  const o = open(t, services({ lrclib: () => ({ status: 200, json: { id: 1, syncedLyrics: lrc, plainLyrics: LINES.join('\n') } }) }))
  await put(o.phone, [aizo()])
  await waitFor(() => { const s = stored(o.phone, 1); return s.lookup !== null && s.lyr.from === 'lrclib' }, { what: 'the lookups' })
  const nets = o.nets()
  const hints = hintsOf({ id: idOf(1), title: 'King Gnu - AIZO', artist: 'Artista sconosciuto', tagless: ['title', 'artist'], edited: [] })
  assert.deepEqual(hints, { title: 'AIZO', artist: 'King Gnu', usable: true })
  assert.deepEqual(nets.map((m) => m.url), [
    'https://musicbrainz.org/ws/2/recording?query=' + encodeURIComponent(searchQuery(hints, 215900)) + '&fmt=json&limit=10',
    'https://musicbrainz.org/ws/2/recording/' + AIZO.id + '?inc=releases+release-groups+media+artist-credits&fmt=json',
    'https://coverartarchive.org/release/' + chooseRelease(AIZO.releases, null).id + '/front-500',
    'https://lrclib.net/api/get?track_name=AIZO&artist_name=King+Gnu&album_name=AIZO&duration=216'
  ])
  checkRequests(nets)
  // What a source writes for the same answers: the values of the release, the cover.
  const want = valuesOf(AIZO, chooseRelease(AIZO.releases, null))
  const s = stored(o.phone, 1)
  assert.equal(s.lookup.state, 'applied')
  assert.deepEqual(s.lookup.filled, [...['title', 'artist', 'albumArtist', 'album', 'year', 'trackNo', 'discNo'].filter((f) => want[f] !== null), 'cover'])
  assert.ok(s.lookup.filled.length >= 6)
  const [x] = (await ask(o.phone, '/api/library?delta=1')).data.tracks
  assert.deepEqual([x.title, x.artist, x.album, x.albumArtist, x.year, x.trackNo, x.discNo, x.coverId], [want.title, want.artist, want.album, want.albumArtist, want.year, want.trackNo, want.discNo, COVER.coverId])
  assert.equal(x.lyrics, 'synced')
  const lyr = (await ask(o.phone, '/api/lyrics/' + idOf(1))).data
  assert.deepEqual(lyr, { trackId: idOf(1), kind: 'synced', lines: [{ t: 1000, text: LINES[0] }, { t: 3000, text: LINES[1] }], from: 'lrclib' })
  // The cover the host made is served from the core's own folder.
  const cover = await ask(o.phone, '/api/cover/' + COVER.coverId + '?size=large')
  assert.equal(cover.status, 200)
  assert.ok(cover.body.equals(Buffer.from(COVER.large, 'base64')))
  // Done: nothing is due, nothing more is asked.
  await sleep(100)
  assert.equal(o.nets().length, 4)
  assert.equal(o.phone.summaryDue(), null)
})

test('a text search with two artists, or none: nothing written but the state, never asked again; a song with tags and a cover asks nothing', async (t) => {
  const o = open(t, services({ search: () => ({ status: 200, json: searchAnswer([{ id: 'other', score: 100, title: 'AIZO', length: 216000, 'artist-credit': [{ name: 'King Gnu feat. Altro' }] }]) }) }))
  await put(o.phone, [aizo(1), facts(2, { tags: { title: 'Mare', artist: 'Lumen Marino', album: 'Ultimo', albumArtist: 'Lumen Marino', trackNo: 1, discNo: 1, year: 2019 }, coverId: 'c'.repeat(24) })])
  await waitFor(() => stored(o.phone, 1).lookup !== null, { what: 'the lookup' })
  const s = stored(o.phone, 1)
  assert.equal(s.lookup.state, 'nothing')
  assert.equal(s.title, 'King Gnu - AIZO', 'the file name stays the title')
  await sleep(100)
  const nets = o.nets()
  assert.equal(nets.filter((m) => m.service === 'musicbrainz').length, 1)
  assert.ok(nets.filter((m) => m.service === 'musicbrainz').every((m) => !m.url.includes('Mare')), 'track 2 is complete: no details asked')
  assert.equal(nets.filter((m) => m.service === 'lrclib').length, 1, 'track 1 has no artist: LRCLIB is not asked about it')
})

test('MusicBrainz 503: it pauses that service and asks again; three in a row fail the track, tried again after 6 h', async (t) => {
  let n = 0
  const o = open(t, services({ search: () => (++n <= 3 ? { status: 503 } : { status: 200, json: searchAnswer() }) }))
  const at = Date.now()
  await put(o.phone, [aizo()])
  await waitFor(() => stored(o.phone, 1).lookup !== null, { what: 'the failure' })
  const s = stored(o.phone, 1)
  assert.equal(s.lookup.state, 'failed')
  assert.equal(s.lookup.tries, 1)
  assert.ok(Date.now() - at >= 40 + 80, 'the back-off waited 40 then 80 ms')
  assert.equal(o.phone.dueOf(idOf(1)).dd, s.lookup.at + 6 * 3600 * 1000)
  assert.equal(o.nets().filter((m) => m.service === 'musicbrainz').length, 3)
})

test('LRCLIB 429 with Retry-After: it waits that long, then asks again; a 404 is a miss, asked again only after 30 days', async (t) => {
  let n = 0
  const o = open(t, services({ lrclib: () => (++n === 1 ? { status: 429, retryAfter: '1' } : { status: 404 }) }))
  const at = Date.now()
  await put(o.phone, [facts(1, { tags: { title: 'Mare', artist: 'Lumen Marino', album: null, albumArtist: null, trackNo: 1, discNo: 1, year: 2019 }, coverId: 'c'.repeat(24) })])
  await waitFor(() => { const s = stored(o.phone, 1); return s.lyr.lookup !== null }, { what: 'the miss', timeout: 5000 })
  assert.ok(Date.now() - at >= 1000, 'Retry-After: 1 s')
  const s = stored(o.phone, 1)
  assert.deepEqual([s.lyr.kind, s.lyr.from, s.lyr.lookup.state, s.lyr.lookup.tries], [null, null, 'none', 1])
  assert.equal(o.phone.dueOf(idOf(1)).ld, s.lyr.lookup.at + 30 * 24 * 3600 * 1000)
  const lr = o.nets().filter((m) => m.service === 'lrclib')
  assert.equal(lr.length, 2)
  assert.equal(lr[0].url, 'https://lrclib.net/api/get?track_name=Mare&artist_name=Lumen+Marino&duration=216', 'an unknown album is left out')
})

test('a miss changes nothing a client sees: the version does not move', async (t) => {
  const o = open(t, services())
  await put(o.phone, [facts(1, { tags: { title: 'Mare', artist: 'Lumen Marino', album: 'Ultimo', albumArtist: null, trackNo: 1, discNo: 1, year: 2019 }, coverId: 'c'.repeat(24) })])
  const v = o.phone.version
  await waitFor(() => stored(o.phone, 1).lyr.lookup !== null, { what: 'the miss' })
  assert.equal(o.phone.version, v)
  assert.equal(stored(o.phone, 1).lyr.lookup.state, 'none')
})

// ------------------------------------------------- the network, the switch

test('no answer at all: nothing is written, no try counted; the worker waits and goes on', async (t) => {
  let n = 0
  const o = open(t, services({ search: () => (++n <= 2 ? { error: 'unreachable' } : { status: 200, json: searchAnswer() }) }))
  const at = Date.now()
  await put(o.phone, [aizo()])
  await sleep(60)
  assert.equal(stored(o.phone, 1).lookup, null, 'nothing written while nothing answers')
  await waitFor(() => stored(o.phone, 1).lookup !== null, { what: 'the lookup after the pauses', timeout: 5000 })
  assert.ok(Date.now() - at >= 150 + 300, 'paused 150 then 300 ms')
  assert.equal(stored(o.phone, 1).lookup.state, 'applied')
  assert.equal(stored(o.phone, 1).lookup.tries, 1)
})

test('a metered network: the host refuses, the worker sends nothing more until the network changes', async (t) => {
  let metered = true
  const o = open(t, (m) => (metered ? { error: 'metered' } : services()(m)))
  await put(o.phone, [aizo()])
  await waitFor(() => o.nets().length >= 1, { what: 'the first request' })
  // Longer than the pauses without an answer (150 then 300 ms): a metered refusal is no such pause.
  await sleep(700)
  const before = o.nets().length
  assert.equal(before, 1, 'one refused request, then nothing until the network changes')
  assert.equal(stored(o.phone, 1).lookup, null)
  metered = false
  o.phone.networkChanged()
  await waitFor(() => stored(o.phone, 1).lookup !== null, { what: 'the lookup on Wi-Fi' })
  assert.equal(stored(o.phone, 1).lookup.state, 'applied')
})

test('the switch off: nothing is sent and what is in flight is dropped; on again, what is due is asked', async (t) => {
  const held = []
  const o = open(t, (m) => { held.push(m); return null })
  let r = {}
  await o.phone.handle(r, { method: 'PATCH', map: {} }, '/api/admin/source', Buffer.from('{"details":false}'))
  assert.equal(r.res.status, 200)
  await put(o.phone, [aizo()])
  await sleep(100)
  assert.equal(o.nets().length, 0, 'off: nothing asked')
  r = {}
  await o.phone.handle(r, { method: 'PATCH', map: {} }, '/api/admin/source', Buffer.from('{"details":true}'))
  await waitFor(() => o.nets().length === 1, { what: 'the request once on' })
  r = {}
  await o.phone.handle(r, { method: 'PATCH', map: {} }, '/api/admin/source', Buffer.from('{"details":false}'))
  // The answer to the request in flight comes now: dropped.
  o.phone.message({ t: 'net-reply', id: held[0].id, status: 200, json: searchAnswer() })
  await sleep(100)
  assert.equal(o.nets().length, 1)
  assert.equal(stored(o.phone, 1).lookup, null)
})

test('songs a real source holds are never asked about; with real sources and no word from the page nothing is asked; one a source no longer holds is', async (t) => {
  const host = new FakeHost()
  host.sources = ['abcd1234']
  host.homeId = 'abcd1234'
  const o = open(t, services(), { host })
  await put(o.phone, [aizo(1), aizo(2)])
  await sleep(100)
  assert.equal(o.nets().length, 0, 'the page has not said which songs the source holds')
  assert.equal(o.phone.entry().shadowed, false)
  await o.phone.shadowed({ all: [idOf(1), idOf(2)] })
  assert.equal(o.phone.entry().shadowed, true)
  await sleep(100)
  assert.equal(o.nets().length, 0, 'both are on the source')
  await o.phone.shadowed({ remove: [idOf(2)] })
  await waitFor(() => stored(o.phone, 2).lookup !== null, { what: 'the song the source no longer holds' })
  await sleep(100)
  assert.ok(o.nets().every((m) => !m.url.includes(idOf(1))))
  assert.equal(stored(o.phone, 1).lookup, null, 'the shadowed one is never asked about')
  // Another source added: the set stands for the old sources only, until the page speaks.
  host.sources = ['abcd1234', 'ef015678']
  assert.equal(o.phone.entry().shadowed, false)
  // Restarted: the set and the sources it was said for come back from the log.
  host.sources = ['abcd1234']
  await o.phone.stop()
  const again = open(t, services(), { dir: o.dir, host })
  assert.equal(again.phone.entry().shadowed, true)
  again.phone.ensureLoaded()
  assert.equal(again.phone.isShadowed(idOf(1)), true)
  assert.equal(again.phone.isShadowed(idOf(2)), false)
})

test('MusicBrainz and the Cover Art Archive: each request starts at least the pace after the previous one and its answer', async (t) => {
  const times = []
  const o = open(t, (m) => { times.push([m.service, Date.now()]); return services()(m) }, { lookups: { ...FAST, pace: { musicbrainz: 120, caa: 120 } } })
  await put(o.phone, [aizo(1), aizo(2)])
  await waitFor(() => stored(o.phone, 1).lookup !== null && stored(o.phone, 2).lookup !== null, { what: 'both lookups', timeout: 5000 })
  const mb = times.filter(([s]) => s === 'musicbrainz').map(([, at]) => at)
  assert.ok(mb.length >= 3)
  for (let i = 1; i < mb.length; i++) assert.ok(mb[i] - mb[i - 1] >= 115, 'MusicBrainz ' + (mb[i] - mb[i - 1]) + ' ms apart')
  // The second song's release was asked before: its cover too, no second request.
  assert.equal(times.filter(([s]) => s === 'caa').length, 1)
  assert.equal(stored(o.phone, 2).coverId, COVER.coverId)
})

test('a start with nothing due reads only the end of the log and asks nothing; with something due, the fill runs after its delay', async (t) => {
  const o = open(t, services())
  await put(o.phone, [aizo(1)])
  await waitFor(() => stored(o.phone, 1).lookup !== null && stored(o.phone, 1).lyr.lookup !== null, { what: 'the lookups' })
  await sleep(50)
  await o.phone.stop()
  const again = open(t, services(), { dir: o.dir })
  await sleep(100)
  assert.equal(again.phone.loaded, false, 'nothing due: the log is not read')
  assert.equal(again.nets().length, 0)
  // A song put with no answer yet: due at the next start.
  const third = open(t, () => null, { dir: path.join(o.dir, '..', 'q') })
  await put(third.phone, [aizo(3)])
  await waitFor(() => third.nets().length > 0, { what: 'the request' })
  await third.phone.stop()
  const fourth = open(t, services(), { dir: third.dir })
  assert.equal(fourth.phone.loaded, false)
  await waitFor(() => fourth.phone.loaded && stored(fourth.phone, 3).lookup !== null, { what: 'the fill after the delay' })
})
