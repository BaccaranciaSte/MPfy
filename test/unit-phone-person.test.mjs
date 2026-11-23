// The phone person store (client-core/phone-person.js): the person's data while it
// lives on the phone, served at Locale's address as a source serves it. Held equal to
// the source: the saved answers of the owner history of test/fixtures-library.mjs,
// the same requests on a source in this process (bodies, user version headers,
// deltas, its log), and the source's person log written by users.mjs and
// userlog.mjs for the same history, byte for byte (the epoch ids drawn from one
// generator). Then what is the store's own: the home of the person's data, the
// move's compare-and-set, a start that reads only the end of the log, a crash at any
// point of a write, compaction while changes keep coming, the playlist covers.

import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClientCore } from '../client-core/index.js'
import { HttpError } from '../client-core/http.js'
import { createMPfy } from '../server/app.mjs'
import * as serverUsers from '../server/users.mjs'
import { coverHashParts } from '../server/media.mjs'
import { savedFiles, maskBody, CLOCK_BASE, CLOCK_STEP } from './fixtures-library.mjs'
import { tmpDir, cleanup, request, json, waitFor, fakeJpeg, testWhoIs } from './helpers.mjs'

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web')
// Imported when a test needs it: a core without it still answers the checks that say what is missing.
const store = () => import('../client-core/phone-person.js')

const T1 = '136a75f36a9c9493fc4187b8'
const T2 = 'f012e680d3cd79dedf26add6'
const T3 = 'c73a7aa55112aa2cace4759d'
const T4 = '1cfa9fe526cb9450185d88df'
const FOREIGN = 'f0'.repeat(12)
const FOREIGN2 = 'e1'.repeat(12)
const ALBUM = '65635b422fc84691'
const P = { one: '0123456789abcdef', trip: '1111111111111111', gone: '2222222222222222' }
const DAY = 24 * 3600 * 1000
const KEPT = ['cache-control', 'content-encoding', 'content-type', 'etag', 'vary']
const ZERO = '0000000000000000'
const PRINCIPAL_KEY = 'cd'.repeat(32)
const PRINCIPAL = PRINCIPAL_KEY.slice(0, 8)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const T = (n) => n.toString(16).padStart(24, '0')

// ------------------------------------------------------------------ helpers

class StepClock {
  constructor () {
    this.t = CLOCK_BASE
    this.now = () => this.t
  }

  tick (ms = CLOCK_STEP) {
    this.t += ms
  }
}

// A seeded generator of numbers in [0, 1).
function rng (seed) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0
    return (s >>> 1) / 0x80000000
  }
}

// Epoch ids in a fixed order (never the zero epoch): the same sequence for each caller.
function epochIds (seed = 1) {
  let k = seed
  return () => (k++ * 0x9e3779b1 >>> 0).toString(16).padStart(8, '0') + (k * 7919).toString(16).padStart(8, '0')
}

// A core with phone music and no network: its links never connect.
const NO_DHT = { on () {}, off () {}, connect () { throw new Error('no network in this check') } }

function writeState (statePath, sources) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true })
  let state = { clientSeed: 'ab'.repeat(32), profile: null, recovery: null, recoveryDeletes: [], sources: [] }
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  } catch {}
  state.sources = sources
  fs.writeFileSync(statePath, JSON.stringify(state))
}

async function phoneCore (base, { now = undefined, epochId = undefined, sources = null } = {}) {
  const statePath = path.join(base, 'state.json')
  if (sources !== null) writeState(statePath, sources)
  const events = []
  const core = createClientCore({
    statePath,
    webRoot: WEB,
    port: 0,
    dht: NO_DHT,
    offlineWaitMs: 100,
    revokeTimeoutMs: 100,
    onEvent: (e) => events.push(e),
    phone: { dir: statePath + '.phone', send: () => {}, now, epochId, lookups: { fillDelayMs: 3600000 } }
  })
  const { port } = await core.start()
  return {
    core,
    port,
    events,
    statePath,
    dir: statePath + '.phone',
    call: (method, p, opts = {}) => request(port, method, p, opts),
    get: async (p) => json(await request(port, 'GET', p)),
    stop: () => core.stop()
  }
}

// The answer as a saved file writes it, from its status line on.
function responseText (res, { library = false } = {}) {
  const lines = ['< ' + res.status]
  for (const h of KEPT) if (res.headers[h] !== undefined) lines.push('< ' + h + ': ' + res.headers[h])
  lines.push('')
  const text = res.body.toString('utf8')
  lines.push(text.length > 0 ? maskBody(text, { library }) : '')
  return lines.join('\n') + '\n'
}

const savedResponse = (text) => text.slice(text.indexOf('\n< ') + 1)
const savedBody = (text) => JSON.parse(text.slice(text.indexOf('\n\n') + 2))

// The person's part of a library answer.
function userPart (a) {
  return { playlists: a.playlists, likes: a.likes, recents: a.recents, covers: a.covers.playlist }
}

// The owner history of the saved answers, as the person's data sees it: every request
// of the history ticks the clock as there; the ones that are no person's data and no
// library answer only tick it here. [kind, ...]: 'start', 'tick', 'jump' ms, 'restart',
// 'lib' record, 'head' record, 'req' method path body record.
const OWNER = [
  ['start'],
  ['lib', '001-library-empty'],
  ['tick'], // 002: a 304 to an earlier tag (Locale's tags are its own)
  ['head', '003-library-head'],
  ['tick'], ['tick'], ['tick'], ['tick'], // four uploads
  ['lib', '004-library-after-uploads'],
  ['lib', '005-library-have-current'],
  ['tick'], // 006: a 304
  ['lib', '007-library-gzip'],
  ['lib', '008-library-have-and-old-etag'],
  ['tick'], // 009: a track edited
  ['lib', '010-library-after-edit'],
  ['jump', 31 * 60 * 1000],
  ['tick'], // a stream
  ['lib', '011-library-after-transcode'],
  ['tick'], ['tick'], ['tick'], // lyrics
  ['lib', '012-library-after-lyrics'],
  ['tick'], ['tick'], ['tick'], ['tick'], // 013 to 016: shared covers
  ['lib', '017-library-after-covers'],
  ['req', 'PUT', '/api/likes/' + T1, null, '018-like-1'],
  ['req', 'PUT', '/api/likes/' + T3, null, '019-like-2'],
  ['req', 'PUT', '/api/likes/' + FOREIGN, null, '020-like-foreign'],
  ['req', 'PUT', '/api/likes/' + T4, null, '021-like-3'],
  ['req', 'PUT', '/api/likes/' + T1, null, '022-like-again'],
  ['req', 'DELETE', '/api/likes/' + T3, null, '023-unlike'],
  ['req', 'DELETE', '/api/likes/' + T3, null, '024-unlike-again'],
  ['req', 'PUT', '/api/likes/' + 'F0'.repeat(12), null, '025-like-bad-id'],
  ['lib', '026-library-after-likes'],
  ['lib', '027-library-after-likes-old-etag'],
  ['req', 'POST', '/api/playlists', { id: P.one }, '028-playlist-create-default-name'],
  ['req', 'POST', '/api/playlists', { id: P.trip, name: '  Viaggio\u0007 ', description: 'In macchina' }, '029-playlist-create-named'],
  ['req', 'POST', '/api/playlists', { id: P.one }, '030-playlist-create-taken-id'],
  ['req', 'POST', '/api/playlists', { id: 'nope' }, '031-playlist-create-bad-id'],
  ['req', 'POST', '/api/playlists/' + P.one + '/tracks', { trackIds: [T1, T2] }, '032-playlist-add'],
  ['req', 'POST', '/api/playlists/' + P.one + '/tracks', { trackIds: [T3, FOREIGN], position: 1 }, '033-playlist-add-at'],
  ['req', 'POST', '/api/playlists/' + P.one + '/tracks', { trackIds: [T1, T4], position: 99 }, '034-playlist-add-past-end'],
  ['req', 'POST', '/api/playlists/' + P.one + '/tracks', { trackIds: [] }, '035-playlist-add-empty'],
  ['req', 'POST', '/api/playlists/' + P.one + '/tracks', { trackIds: [T1], position: -1 }, '036-playlist-add-bad-position'],
  ['req', 'DELETE', '/api/playlists/' + P.one + '/tracks', { indexes: [2] }, '037-playlist-remove-index'],
  ['req', 'DELETE', '/api/playlists/' + P.one + '/tracks', { indexes: [4], ids: [T1], counts: [2] }, '038-playlist-remove-checked'],
  ['req', 'DELETE', '/api/playlists/' + P.one + '/tracks', { indexes: [0], ids: [FOREIGN] }, '039-playlist-remove-gone'],
  ['req', 'DELETE', '/api/playlists/' + P.one + '/tracks', { indexes: [40] }, '040-playlist-remove-out-of-range'],
  ['req', 'POST', '/api/playlists/' + P.one + '/tracks', { trackIds: [FOREIGN2], position: 0 }, '041-playlist-add-again'],
  ['req', 'PATCH', '/api/playlists/' + P.one, { trackIds: [T4, T2, T3, T1], base: [T1, T3, T2, T4] }, '042-playlist-reorder-rebased'],
  ['req', 'PATCH', '/api/playlists/' + P.one, { trackIds: [T1, T2, T3, T4, FOREIGN2] }, '043-playlist-reorder-whole'],
  ['req', 'PATCH', '/api/playlists/' + P.trip, { name: 'Viaggio lungo' }, '044-playlist-rename'],
  ['req', 'PATCH', '/api/playlists/' + P.trip, { description: null }, '045-playlist-describe-null'],
  ['req', 'PATCH', '/api/playlists/' + P.trip, { name: '   ' }, '046-playlist-rename-empty'],
  ['req', 'PATCH', '/api/playlists/' + 'ffffffffffffffff', { name: 'X' }, '047-playlist-unknown'],
  ['req', 'POST', '/api/playlists/' + P.trip + '/tracks', { trackIds: [T2, T4, FOREIGN] }, '048-playlist-trip-add'],
  ['req', 'POST', '/api/playlists', { id: P.gone, name: 'Da togliere' }, '049-playlist-create-to-delete'],
  ['req', 'PUT', '/api/cover-for/playlist/' + P.gone + '?size=small', fakeJpeg(31, 1500), '050-cover-playlist-put-small'],
  ['req', 'PUT', '/api/cover-for/playlist/' + P.trip + '?size=small', fakeJpeg(32, 1500), '051-cover-playlist-put-small-2'],
  ['req', 'PUT', '/api/cover-for/playlist/' + P.trip + '?size=large', fakeJpeg(33, 4000), '052-cover-playlist-put-large'],
  ['req', 'PUT', '/api/cover-for/playlist/' + P.one + '?size=large', fakeJpeg(34, 4000), '053-cover-playlist-put-large-2'],
  ['req', 'DELETE', '/api/cover-for/playlist/' + P.one, null, '054-cover-playlist-delete'],
  ['lib', '055-library-after-playlists'],
  ['req', 'DELETE', '/api/playlists/' + P.gone, null, '056-playlist-delete'],
  ['req', 'DELETE', '/api/playlists/' + P.gone, null, '057-playlist-delete-again'],
  ['lib', '058-library-after-playlist-delete'],
  ['req', 'POST', '/api/played', { trackId: T1, context: { type: 'playlist', id: P.one } }, '059-played'],
  ['req', 'POST', '/api/played', { trackId: T2 }, '060-played-no-context'],
  ['req', 'POST', '/api/played', (now) => ({ trackId: FOREIGN, at: now - 2 * 3600 * 1000, context: { type: 'liked' } }), '061-played-offline'],
  ['req', 'POST', '/api/played', (now) => ({ trackId: T3, at: now - 3 * 3600 * 1000, context: { type: 'album', id: ALBUM } }), '062-played-offline-older'],
  ['req', 'POST', '/api/played', (now) => ({ trackId: T4, at: now - 40 * DAY }), '063-played-too-old'],
  ['req', 'POST', '/api/played', (now) => ({ trackId: T2, at: now + 3600 * 1000, context: { type: 'search' } }), '064-played-future'],
  ['req', 'POST', '/api/played', { trackId: T2, context: { type: 'radio' } }, '065-played-bad-context'],
  ['req', 'POST', '/api/played', { trackId: 'x' }, '066-played-bad-id'],
  ['lib', '067-library-after-plays'],
  ['req', 'GET', '/api/recents?limit=3', null, '068-recents-page'],
  ['req', 'GET', '/api/recents', null, '069-recents-all'],
  ['tick'], // 070: a track deleted on the source (the phone store never sweeps a track)
  ['lib', '071-library-after-track-delete'],
  ['restart'],
  ['lib', '072-library-after-restart'],
  ['tick'], // 073: a 304
  ['lib', '074-library-after-restart-have-current'],
  ['req', 'PUT', '/api/likes/' + T2, null, '075-like-after-restart'],
  ['req', 'POST', '/api/played', { trackId: T3, context: { type: 'artist', id: 'le-boe' } }, '076-played-after-restart'],
  ['lib', '077-library-after-restart-changes'],
  ['lib', '078-library-after-restart-changes-gzip']
]

/**
 * Play steps on a side: { start, restart, send(method, path, body) (the clock ticks
 * first), probe() (a check that changes nothing, after each step) }. Resolves
 * [{ step, res }] for the steps that sent a request.
 */
async function play (steps, side, clock, { probe = null } = {}) {
  const out = []
  for (const step of steps) {
    const kind = step[0]
    if (kind === 'start') {
      clock.tick()
      await side.start()
    } else if (kind === 'restart') {
      await side.stop()
      clock.tick()
      await side.start()
    } else if (kind === 'tick') {
      clock.tick()
    } else if (kind === 'jump') {
      clock.tick(step[1])
    } else {
      clock.tick()
      let res
      if (kind === 'lib') res = await side.send('GET', '/api/library', null)
      else if (kind === 'head') res = await side.send('HEAD', '/api/library', null)
      else res = await side.send(step[1], step[2], typeof step[3] === 'function' ? step[3](clock.t) : step[3])
      out.push({ step, res })
    }
    if (probe !== null && kind !== 'tick' && kind !== 'jump') await probe(step)
  }
  return out
}

// The track deleted on the source at 070 taken out of an answer of the phone store (which
// never sweeps a track), and the times it moved masked on both sides.
function withoutT4 (body, saved) {
  const held = new Set()
  const scrub = (pl) => {
    if (!pl || !Array.isArray(pl.trackIds)) return pl
    if (pl.trackIds.includes(T4)) held.add(pl.id)
    return { ...pl, trackIds: pl.trackIds.filter((id) => id !== T4) }
  }
  const out = { ...body }
  if (Array.isArray(out.playlists)) out.playlists = out.playlists.map(scrub)
  if (Array.isArray(out.likes)) out.likes = out.likes.filter((l) => l.id !== T4)
  if (Array.isArray(out.recents)) out.recents = out.recents.filter((r) => r.trackId !== T4)
  const mask = (x) => {
    if (Array.isArray(x.playlists)) x.playlists = x.playlists.map((pl) => (held.has(pl.id) ? { ...pl, updatedAt: '(moved by the sweep)' } : pl))
    return x
  }
  return [mask(out), mask({ ...saved })]
}

function userHeaders (res) {
  return [res.headers['x-mpfy-user-version'] ?? null, res.headers['x-mpfy-user-epoch'] ?? null]
}

// ------------------------------------------------------------------ the source's answers

test('the person routes at /s/0000 answer the owner history as the saved answers: statuses, headers, bodies, and the person part of the library', async (t) => {
  const c = cleanup(t)
  const base = c.dir(tmpDir('mpfy-person-fix-'))
  const clock = new StepClock()
  const saved = new Map(savedFiles('owner').map((f) => [f.name.replace(/\.txt$/, ''), f.text]))
  let h = null
  t.after(() => (h !== null ? h.stop() : null))
  const side = {
    start: async () => { h = await phoneCore(base, { now: clock.now }) },
    stop: () => h.stop(),
    send: (method, p, body) => h.call(method, '/s/0000' + p, { body })
  }
  const answers = await play(OWNER, side, clock)
  let compared = 0
  let after = false
  for (const { step, res } of answers) {
    const record = step[step.length - 1]
    if (step[0] === 'tick') continue
    if (record === '071-library-after-track-delete') after = true
    const text = saved.get(record)
    assert.ok(text !== undefined, 'a saved answer ' + record)
    if (step[0] === 'head') {
      assert.equal(res.status, 200, record)
      assert.equal(res.body.length, 0, record)
      continue
    }
    if (step[0] === 'lib') {
      assert.equal(res.status, 200, record)
      let mine = userPart(JSON.parse(maskBody(res.body.toString('utf8'), { library: true })))
      let theirs = userPart(savedBody(text))
      if (after) [mine, theirs] = withoutT4(mine, theirs)
      assert.deepEqual(mine, theirs, record + ': the person part of the library')
      compared++
      continue
    }
    if (step[2].startsWith('/api/cover-for/')) {
      // The track and album covers of the answer are the source's shared ones: Locale has
      // none (the phone's are empty); the person's playlist covers equal.
      const mineText = responseText(res)
      const theirs = savedResponse(text)
      assert.equal(mineText.slice(0, mineText.indexOf('\n\n')), theirs.slice(0, theirs.indexOf('\n\n')), record + ': status and headers')
      const a = JSON.parse(mineText.slice(mineText.indexOf('\n\n') + 2))
      const b = JSON.parse(theirs.slice(theirs.indexOf('\n\n') + 2))
      assert.deepEqual([a.covers.track, a.covers.album], [{}, {}], record)
      assert.deepEqual(Object.keys(a.covers), Object.keys(b.covers), record)
      assert.deepEqual(a.covers.playlist, b.covers.playlist, record)
    } else if (!after) {
      assert.equal(responseText(res), savedResponse(text), record)
    } else {
      const mineText = responseText(res)
      const theirs = savedResponse(text)
      assert.equal(mineText.slice(0, mineText.indexOf('\n\n')), theirs.slice(0, theirs.indexOf('\n\n')), record + ': status and headers')
      const [a, b] = withoutT4(JSON.parse(mineText.slice(mineText.indexOf('\n\n') + 2)), JSON.parse(theirs.slice(theirs.indexOf('\n\n') + 2)))
      assert.deepEqual(a, b, record)
    }
    compared++
  }
  assert.equal(compared, 68, 'every saved answer of the person routes (49) and of the library (19) compared')
})

// The steps after the owner history: random requests of every kind on the person's data,
// a few restarts and clock jumps; the same for every side (they never look at an answer).
function randomSteps (seed, n) {
  const r = rng(seed)
  const pick = (a) => a[Math.floor(r() * a.length)]
  const tracks = Array.from({ length: 30 }, (_, i) => T(i + 1))
  const lists = ['a0a0a0a0a0a0a0a0', 'b1b1b1b1b1b1b1b1', 'c2c2c2c2c2c2c2c2', P.one]
  const some = (k) => Array.from({ length: k }, () => pick(tracks))
  const steps = []
  for (let i = 0; i < n; i++) {
    const x = r()
    const pl = pick(lists)
    if (x < 0.14) steps.push(['req', 'PUT', '/api/likes/' + pick(tracks) + (r() < 0.5 ? '?brief=1' : ''), null])
    else if (x < 0.22) steps.push(['req', 'DELETE', '/api/likes/' + pick(tracks) + (r() < 0.5 ? '?brief=1' : ''), null])
    else if (x < 0.29) steps.push(['req', 'POST', '/api/likes', { add: some(Math.floor(r() * 6)), remove: some(Math.floor(r() * 4)) }])
    else if (x < 0.34) steps.push(['req', 'POST', '/api/playlists', r() < 0.8 ? { id: pl, name: 'Lista ' + i, description: r() < 0.5 ? 'note ' + i : undefined } : { id: pl }])
    else if (x < 0.46) steps.push(['req', 'POST', '/api/playlists/' + pl + '/tracks', r() < 0.5 ? { trackIds: some(1 + Math.floor(r() * 4)) } : { trackIds: some(2), position: Math.floor(r() * 6) }])
    else if (x < 0.54) {
      const k = Math.floor(r() * 6)
      steps.push(['req', 'DELETE', '/api/playlists/' + pl + '/tracks', r() < 0.5 ? { indexes: [k] } : { indexes: [k], ids: [pick(tracks)], counts: r() < 0.5 ? [1 + Math.floor(r() * 2)] : undefined }])
    } else if (x < 0.61) {
      const body = {}
      if (r() < 0.4) body.name = r() < 0.1 ? '  ' : 'Nome ' + i
      if (r() < 0.3) body.description = r() < 0.3 ? null : 'Descrizione ' + i
      if (r() < 0.5) {
        body.trackIds = some(Math.floor(r() * 5))
        if (r() < 0.5) body.base = some(Math.floor(r() * 5))
      }
      steps.push(['req', 'PATCH', '/api/playlists/' + pl, body])
    } else if (x < 0.64) steps.push(['req', 'DELETE', '/api/playlists/' + pl, null])
    else if (x < 0.69) steps.push(['req', 'PUT', '/api/cover-for/playlist/' + pl + '?size=' + pick(['small', 'large']), fakeJpeg(40 + Math.floor(r() * 4), 1500)])
    else if (x < 0.72) steps.push(['req', 'DELETE', '/api/cover-for/playlist/' + pl, null])
    else if (x < 0.86) {
      const ctx = pick([undefined, { type: 'playlist', id: pl }, { type: 'library' }, { type: 'album', id: ALBUM }])
      const offset = pick([null, -3600 * 1000, -29 * DAY, -31 * DAY, 4 * 60 * 1000, 3600 * 1000])
      const trackId = pick(tracks)
      steps.push(['req', 'POST', '/api/played', offset === null ? { trackId, context: ctx } : (now) => ({ trackId, context: ctx, at: now + offset })])
    } else if (x < 0.9) steps.push(['req', 'GET', '/api/recents?limit=' + (1 + Math.floor(r() * 7)), null])
    else if (x < 0.93) steps.push(['lib'])
    else if (x < 0.96) steps.push(['jump', Math.floor(r() * 3 * DAY)])
    else if (x < 0.975) steps.push(['restart'])
    else steps.push(['tick'])
  }
  return steps
}

// A side that keeps what each check of its deltas said: the user part a client holds after
// each answer, the held versions sent, and a client applying the deltas.
function deltaProber (send) {
  const seen = []
  const held = []
  let n = 0
  return {
    seen,
    async probe () {
      n++
      // Mostly the last versions held; sometimes older ones (several steps of changes), sometimes none.
      const h = n % 7 === 0 ? null : n % 4 === 0 && held.length > 3 ? held[held.length - 4] : held.length > 0 ? held[held.length - 1] : null
      const q = '/api/library?delta=1' + (h !== null ? '&uv=' + h.uv + '&ue=' + h.ue : '')
      const res = await send('GET', q)
      assert.equal(res.status, 200)
      const a = json(res)
      held.push({ uv: a.userVersion, ue: a.epochs.user })
      seen.push({ asked: h, userVersion: a.userVersion, epoch: a.epochs.user, delta: a.delta.user, part: JSON.stringify(userPart(a)) })
    }
  }
}

test('the same requests on a source in this process: the same bodies, the same user versions in the headers, the same deltas, the same log', async (t) => {
  const c = cleanup(t)
  const srcDir = c.dir(tmpDir('mpfy-person-src-'))
  const base = c.dir(tmpDir('mpfy-person-oracle-'))
  const steps = [...OWNER, ...randomSteps(7, 260)]

  // The source, on the step clock of the saved answers.
  const sclock = new StepClock()
  let app = null
  const realNow = Date.now
  Date.now = sclock.now
  let fromSource
  const sp = deltaProber((method, p) => request(app.ports.http, method, p))
  try {
    const side = {
      start: async () => {
        app = await createMPfy({ dataDir: srcDir, port: 0, adminPort: 0, p2p: false, debounceMs: 10, name: 'Fonte di prova', ffmpeg: null, fpcalc: null, sevenZip: null, whoIs: testWhoIs })
        await app.jobsStarted
        await app.songsStarted
      },
      stop: async () => {
        await app.close()
        app = null
      },
      send: (method, p, body) => request(app.ports.http, method, p, { body })
    }
    fromSource = await play(steps, side, sclock, { probe: () => sp.probe() })
  } finally {
    if (app !== null) await app.close()
    Date.now = realNow
  }

  // The phone store, on the same clock.
  const pclock = new StepClock()
  let h = null
  t.after(() => (h !== null ? h.stop() : null))
  const pp = deltaProber((method, p) => h.call(method, '/s/0000' + p))
  const side = {
    start: async () => { h = await phoneCore(base, { now: pclock.now }) },
    stop: async () => {
      await h.stop()
      h = null
    },
    send: (method, p, body) => h.call(method, '/s/0000' + p, { body })
  }
  const fromPhone = await play(steps, side, pclock, { probe: () => pp.probe() })
  await h.stop()
  h = null

  // Epochs are drawn at random by each: one of the source's always stands for the same of the phone's.
  const epochs = new Map()
  const back = new Map()
  const sameEpoch = (a, b, what) => {
    if (a === null || b === null || a === ZERO || b === ZERO) return assert.equal(a, b, what)
    if (!epochs.has(a)) {
      assert.ok(!back.has(b), what + ': an epoch of the phone stands for two of the source')
      epochs.set(a, b)
      back.set(b, a)
    }
    assert.equal(epochs.get(a), b, what)
  }
  assert.equal(fromPhone.length, fromSource.length)
  let writes = 0
  for (let i = 0; i < fromSource.length; i++) {
    const { step, res: s } = fromSource[i]
    const p = fromPhone[i].res
    const what = i + ' ' + step.slice(0, 3).filter((x) => typeof x === 'string').join(' ')
    assert.equal(p.status, s.status, what)
    if (step[0] === 'lib') {
      assert.deepEqual(userPart(json(p)), userPart(json(s)), what)
      assert.equal(json(p).userVersion, json(s).userVersion, what)
      continue
    }
    if (step[0] === 'head') continue
    assert.equal(p.body.toString('utf8'), s.body.toString('utf8'), what)
    const [sv, se] = userHeaders(s)
    const [pv, pe] = userHeaders(p)
    assert.equal(pv, sv, what + ': the user version')
    sameEpoch(se, pe, what + ': the user epoch')
    if (sv !== null) writes++
  }
  assert.ok(writes > 100, 'answers with the user version: ' + writes)
  // The deltas: the same part after every step, for the same versions held.
  assert.equal(pp.seen.length, sp.seen.length)
  let deltas = 0
  for (let i = 0; i < sp.seen.length; i++) {
    const a = sp.seen[i]
    const b = pp.seen[i]
    const what = 'check ' + i
    assert.equal(b.userVersion, a.userVersion, what)
    sameEpoch(a.epoch, b.epoch, what)
    assert.equal(b.delta, a.delta, what + ': a delta')
    assert.equal(b.part, a.part, what)
    if (a.delta && a.asked !== null && a.asked.uv !== a.userVersion) deltas++
  }
  assert.ok(deltas > 50, 'deltas that carried changes: ' + deltas)
  // The log on disk: the source's, byte for byte, but for the ids its epochs drew.
  const norm = (text) => {
    const ids = new Map()
    return text.replace(/(?<=")[0-9a-f]{16}(?=")/g, (m) => {
      if (!epochs.has(m) && !back.has(m)) return m
      const key = back.has(m) ? back.get(m) : m
      if (!ids.has(key)) ids.set(key, 'e' + String(ids.size).padStart(15, '0'))
      return ids.get(key)
    })
  }
  const theirs = fs.readFileSync(path.join(srcDir, 'users', 'owner.log'), 'utf8')
  const mine = fs.readFileSync(path.join(base, 'state.json.phone', 'person.log'), 'utf8')
  assert.equal(norm(mine), norm(theirs))
})

// ------------------------------------------------------------------ the format

// The same history as method calls: [name, ...args]; 'restart', 'compact', 'freeze' (the
// clock stops), 'thaw'.
function formatOps (seed, n) {
  const r = rng(seed)
  const pick = (a) => a[Math.floor(r() * a.length)]
  const tracks = Array.from({ length: 60 }, (_, i) => T(i + 100))
  const lists = ['a0a0a0a0a0a0a0a0', 'b1b1b1b1b1b1b1b1', 'c2c2c2c2c2c2c2c2']
  const covers = Array.from({ length: 5 }, (_, i) => 'c' + T(i).slice(1))
  const some = (k) => Array.from({ length: k }, () => pick(tracks))
  const ops = []
  for (let i = 0; i < n; i++) {
    const x = r()
    const pl = pick(lists)
    if (x < 0.15) ops.push(['like', pick(tracks)])
    else if (x < 0.24) ops.push(['unlike', pick(tracks)])
    else if (x < 0.3) ops.push(['bulkLikes', { add: some(Math.floor(r() * 5)), remove: some(Math.floor(r() * 3)) }])
    else if (x < 0.35) ops.push(['createPlaylist', { id: pl, name: r() < 0.5 ? 'Lista ' + i : undefined }])
    else if (x < 0.47) ops.push(['addToPlaylist', pl, some(1 + Math.floor(r() * 3)), r() < 0.5 ? undefined : Math.floor(r() * 5)])
    else if (x < 0.54) ops.push(['removeFromPlaylist', pl, [Math.floor(r() * 5)], r() < 0.5 ? undefined : [pick(tracks)], undefined])
    else if (x < 0.6) ops.push(['updatePlaylist', pl, r() < 0.5 ? { name: 'Nome ' + i } : { trackIds: some(3), base: r() < 0.5 ? some(3) : undefined }])
    else if (x < 0.63) ops.push(['deletePlaylist', pl])
    else if (x < 0.68) ops.push(['setPlaylistCover', pl, pick(['small', 'large']), pick(covers)])
    else if (x < 0.7) ops.push(['clearPlaylistCover', pl])
    else if (x < 0.9) ops.push(['played', pick(tracks), r() < 0.5 ? { type: 'playlist', id: pl } : undefined, r() < 0.3 ? null : undefined])
    else if (x < 0.95) ops.push(['restart'])
    else ops.push(['compact'])
  }
  return ops
}

test('the log is the source\'s, byte for byte: one history through users.mjs and the phone store, the epoch ids from one generator, after every compaction and restart', async (t) => {
  const { PhonePerson } = await store()
  const c = cleanup(t)
  const base = c.dir(tmpDir('mpfy-person-format-'))
  const srcDir = path.join(base, 'source')
  const phoneDir = path.join(base, 'phone')
  const KEY = 'ab'.repeat(16)
  const clock = new StepClock()
  let frozen = false
  const now = () => clock.t
  const realNow = Date.now
  const realRandom = crypto.randomBytes
  Date.now = now
  t.after(() => {
    Date.now = realNow
    crypto.randomBytes = realRandom
  })
  // The source draws its epoch ids through crypto.randomBytes(8): from the generator while it runs.
  const fromS = epochIds(5)
  const fromP = epochIds(5)
  const withIds = (fn) => {
    crypto.randomBytes = (n, ...rest) => (n === 8 && rest.length === 0 ? Buffer.from(fromS(), 'hex') : realRandom(n, ...rest))
    try {
      return fn()
    } finally {
      crypto.randomBytes = realRandom
    }
  }
  const host = new FakeHost(KEY)
  let users = null
  let src = null
  let phone = null
  const open = async () => {
    users = new serverUsers.Users({ dataDir: srcDir })
    users.load()
    src = (await users.open(KEY)).user
    await src.log.settled()
    phone = new PhonePerson({ dir: phoneDir, host, now, epochId: fromP })
    await phone.ready()
    await phone.settled()
  }
  const close = async () => {
    users.close()
    await phone.stop()
  }
  const srcLog = path.join(srcDir, 'users', KEY + '.log')
  const phoneLog = path.join(phoneDir, 'person.log')
  let checks = 0
  const same = (what) => {
    const a = fs.readFileSync(srcLog)
    const b = fs.readFileSync(phoneLog)
    if (!a.equals(b)) {
      let i = 0
      while (i < a.length && i < b.length && a[i] === b[i]) i++
      assert.fail(what + ': the logs differ at byte ' + i + '\n  source: ' + JSON.stringify(a.subarray(Math.max(0, i - 120), i + 120).toString()) + '\n  phone:  ' + JSON.stringify(b.subarray(Math.max(0, i - 120), i + 120).toString()))
    }
    checks++
  }
  const outcome = (fn) => {
    try {
      const v = fn()
      return 'ok ' + JSON.stringify(v === undefined ? null : v)
    } catch (err) {
      if (!(err instanceof Error) || typeof err.status !== 'number') throw err
      return 'error ' + err.status + ' ' + err.message + ' ' + (err.code || '')
    }
  }
  fs.mkdirSync(srcDir, { recursive: true })
  await open()

  // The owner history's changes, then random ones, then the cases at the edges: thousands of
  // likes (several chunks), more than 10,000 removals kept (the horizon), more than 64 epochs,
  // a burst of changes faster than the clock (a version ahead of it at the next start).
  const ownerOps = OWNER.filter((s) => s[0] === 'req' && s[1] !== 'GET' && !s[2].startsWith('/api/cover-for'))
    .map((s) => ['http', s[1], s[2], s[3]])
  const big = (k) => Array.from({ length: 5000 }, (_, i) => T(1000000 + k * 5000 + i))
  const ops = [
    ...ownerOps,
    ['compact'],
    ...formatOps(3, 700),
    ['bulkLikes', { add: big(0) }], ['bulkLikes', { add: big(1) }], ['compact'],
    ['bulkLikes', { remove: big(0) }], ['bulkLikes', { remove: big(1) }], ['bulkLikes', { add: big(2) }], ['bulkLikes', { remove: big(2) }],
    ['compact'],
    ...Array.from({ length: 70 }, (_, i) => [['like', T(500 + i)], ['restart']]).flat(),
    ['compact'],
    // The clock stopped: the versions run ahead of it, and the next run's epoch begins past them.
    ['freeze'], ...Array.from({ length: 1500 }, (_, i) => ['played', T(i % 50 + 100), undefined, undefined]), ['restart'],
    ['like', T(700)], ['like', T(701)], ['thaw'],
    ...formatOps(4, 200),
    ['compact'], ['restart'], ['compact']
  ]
  const http = (user, method, p, body) => {
    // The owner history's requests, as the source's routes turn them into calls.
    const seg = p.slice(5).split('?')[0].split('/')
    const now0 = clock.t
    const b = typeof body === 'function' ? body(now0) : body
    if (seg[0] === 'likes') return method === 'PUT' ? user.like(seg[1]) : user.unlike(seg[1])
    if (seg[0] === 'played') return user.played(b.trackId, b.context, b.at)
    if (seg.length === 1) return user.createPlaylist(b)
    if (seg.length === 2) return method === 'PATCH' ? user.updatePlaylist(seg[1], b) : user.deletePlaylist(seg[1])
    if (method === 'POST') return user.addToPlaylist(seg[1], b.trackIds, b.position)
    return user.removeFromPlaylist(seg[1], b.indexes, b.ids, b.counts)
  }
  for (const op of ops) {
    const name = op[0]
    if (name === 'restart') {
      await close()
      if (!frozen) clock.tick()
      await open()
      same('after a restart')
      continue
    }
    if (name === 'compact') {
      await src.log.compact()
      await phone.compact()
      same('after a compaction')
      continue
    }
    if (name === 'freeze' || name === 'thaw') {
      frozen = name === 'freeze'
      continue
    }
    if (!frozen) clock.tick()
    const call = name === 'http'
      ? (user) => http(user, op[1], op[2], op[3])
      : (user) => user[name](...op.slice(1))
    const a = outcome(() => withIds(() => call(src)))
    const b = outcome(() => call(phone))
    assert.equal(b, a, JSON.stringify(op).slice(0, 200))
    await src.log.settled()
    await phone.settled()
  }
  same('at the end')
  await close()
  assert.ok(checks > 40, 'compared ' + checks + ' times')
  const text = fs.readFileSync(phoneLog, 'utf8')
  const end = JSON.parse(text.split('\n').find((l) => l.startsWith('{"E":')))
  assert.ok(end.sum.h > 0, 'removals past the 10,000 kept raised the horizon')
  assert.equal(end.sum.ep.length, 64, 'at most 64 epochs kept')
})

// ------------------------------------------------------------------ the home and the move

// The core's side for a store used alone.
class FakeHost {
  constructor (key = 'ab'.repeat(16)) {
    this.key = key
    this.logs = []
    this.moves = 0
  }

  profileId () { return this.key }
  json (conn, status, obj, headers = {}) { conn.res = { status, headers: headers || {}, body: Buffer.from(JSON.stringify(obj)) } }
  send (conn, status, headers, body) { conn.res = { status, headers, body: body === null ? null : Buffer.from(body) } }
  async pieces (conn, status, headers, pieces) {
    let text = ''
    for (const p of pieces) text += p
    conn.res = { status, headers, body: Buffer.from(text) }
  }

  readBody (conn, req, rest, max) {
    if (rest.length > max) return Promise.reject(new HttpError(413, 'Richiesta troppo grande'))
    return Promise.resolve(rest)
  }

  homeMayHaveMoved () { this.moves++ }
  log (line) { this.logs.push(line) }
}

async function ask (s, method, target, body = null) {
  const conn = {}
  const raw = body === null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))
  await s.handle(conn, { method, map: {} }, target, raw)
  const res = conn.res
  if (res && res.body && res.body.length > 0) {
    try {
      res.data = JSON.parse(res.body.toString('utf8'))
    } catch {}
  }
  return res
}

const sources = () => [{ serverPublicKey: PRINCIPAL_KEY, name: 'Fonte di casa', principal: true, addedAt: 1 }]
const homeOf = (h) => h.events.filter((e) => e.type === 'sources').map((e) => e.home).pop()

test('the home: no real source, the phone store; a principal and an empty store, the principal; a principal and a store holding data, the store (the move is due); after the move, the principal', async (t) => {
  const c = cleanup(t)
  const base = c.dir(tmpDir('mpfy-person-home-'))
  let h = null
  t.after(() => (h !== null ? h.stop() : null))
  h = await phoneCore(base)
  assert.equal(homeOf(h), '0000', 'no real source')
  assert.equal((await h.get('/local/sources')).phone.home, true)
  await h.stop()

  // A principal and nothing in the store: the principal, as before.
  h = await phoneCore(base, { sources: sources() })
  assert.equal(homeOf(h), PRINCIPAL)
  assert.equal((await h.get('/local/sources')).phone.home, false)
  // The person's data is the principal's: nothing lands in the store.
  const r = await h.call('PUT', '/s/0000/api/likes/' + T1)
  assert.equal(r.status, 503, 'forwarded to the principal, which is offline here')
  assert.equal(fs.existsSync(path.join(h.dir, 'person.log')), false)
  await h.stop()

  // Data in the store, then a principal: the store stays the home until the move.
  writeState(path.join(base, 'state.json'), [])
  h = await phoneCore(base)
  assert.equal((await h.call('PUT', '/s/0000/api/likes/' + T1 + '?brief=1')).status, 200)
  await h.stop()
  h = await phoneCore(base, { sources: sources() })
  assert.equal(homeOf(h), '0000', 'the move is due')
  assert.equal((await h.get('/local/sources')).phone.home, true, 'the move is due')
  const lib = await h.get('/s/0000/api/library?delta=1')
  assert.deepEqual(lib.likes.map((l) => l.id), [T1], 'the store answers while it is the home')

  const moved = await h.call('POST', '/local/phone/moved', { body: { to: PRINCIPAL, uv: lib.userVersion, ue: lib.epochs.user } })
  assert.equal(moved.status, 200, moved.body.toString())
  assert.deepEqual(json(moved), { ok: true })
  await waitFor(() => homeOf(h) === PRINCIPAL, { what: 'the sources event with the new home' })
  assert.equal((await h.get('/local/sources')).phone.home, false)
  await h.stop()

  // Every real source removed: the store is the home again, empty, with a new epoch.
  h = await phoneCore(base)
  const del = await h.call('DELETE', '/local/sources/' + PRINCIPAL)
  assert.equal(del.status, 200, del.body.toString())
  await waitFor(() => homeOf(h) === '0000', { what: 'the home back on the phone' })
  const empty = await h.get('/s/0000/api/library?delta=1')
  assert.deepEqual([empty.userVersion, empty.epochs.user, empty.likes], [0, ZERO, []])
  assert.equal((await h.call('PUT', '/s/0000/api/likes/' + T2 + '?brief=1')).status, 200)
  const again = await h.get('/s/0000/api/library?delta=1')
  assert.deepEqual(again.likes.map((l) => l.id), [T2])
  assert.notEqual(again.epochs.user, lib.epochs.user, 'a new log, a new epoch')
})

test('POST /local/phone/moved: a compare-and-set of the store\'s versions; the log kept aside as person.log.moved-<ms> (the newest only), the store empty; writes then go to the principal', async (t) => {
  const c = cleanup(t)
  const base = c.dir(tmpDir('mpfy-person-moved-'))
  let h = null
  t.after(() => (h !== null ? h.stop() : null))
  h = await phoneCore(base)
  for (const id of [T1, T2, T3]) assert.equal((await h.call('PUT', '/s/0000/api/likes/' + id + '?brief=1')).status, 200)
  await h.stop()
  h = await phoneCore(base, { sources: sources() })
  let lib = await h.get('/s/0000/api/library?delta=1')
  const move = (body) => h.call('POST', '/local/phone/moved', { body })
  for (const bad of [{}, { to: PRINCIPAL }, { to: PRINCIPAL, uv: -1, ue: lib.epochs.user }, { to: PRINCIPAL, uv: lib.userVersion, ue: 'XYZ' }, { to: 5, uv: 1, ue: ZERO }, { to: PRINCIPAL, uv: 1, ue: ZERO, other: 1 }]) {
    const r = await move(bad)
    assert.equal(r.status, 400, JSON.stringify(bad))
    assert.equal(json(r).code, 'bad_request')
  }
  let r = await move({ to: 'ab12cd34', uv: lib.userVersion, ue: lib.epochs.user })
  assert.equal(r.status, 404, 'not the principal')
  assert.equal(json(r).code, 'not_found')
  // A like during the move: the versions noted no longer hold.
  assert.equal((await h.call('PUT', '/s/0000/api/likes/' + T4 + '?brief=1')).status, 200)
  r = await move({ to: PRINCIPAL, uv: lib.userVersion, ue: lib.epochs.user })
  assert.equal(r.status, 409, 'a like during the move is kept')
  assert.equal(json(r).code, 'changed')
  assert.ok(fs.existsSync(path.join(h.dir, 'person.log')), 'nothing set aside')
  assert.equal((await h.get('/local/sources')).phone.home, true)
  lib = await h.get('/s/0000/api/library?delta=1')
  assert.deepEqual(lib.likes.map((l) => l.id), [T4, T3, T2, T1])
  r = await move({ to: PRINCIPAL, uv: lib.userVersion, ue: lib.epochs.user })
  assert.equal(r.status, 200, r.body.toString())
  const aside = fs.readdirSync(h.dir).filter((n) => n.startsWith('person.log'))
  assert.equal(aside.length, 1)
  assert.match(aside[0], /^person\.log\.moved-\d+$/)
  assert.equal((await h.get('/local/sources')).phone.home, false)
  const v = (await h.get('/local/sources')).phone.v
  assert.match(v, /\.0$/, 'the store answers the zero version')
  const after = await h.get('/s/0000/api/library?delta=1')
  assert.deepEqual([after.userVersion, after.epochs.user, after.likes], [0, ZERO, []])
  // A like still sent to the phone's address goes to the principal (offline here), never to the store.
  r = await h.call('PUT', '/s/0000/api/likes/' + FOREIGN + '?brief=1')
  assert.equal(r.status, 503)
  assert.equal(fs.existsSync(path.join(h.dir, 'person.log')), false)
  // Moved again with what the store says now: nothing to move, and fine.
  r = await move({ to: PRINCIPAL, uv: 0, ue: ZERO })
  assert.equal(r.status, 200)
  await h.stop()

  // A crash between the rename and the answer: the store empty, the home moved.
  writeState(path.join(base, 'state.json'), [])
  h = await phoneCore(base)
  assert.equal((await h.call('PUT', '/s/0000/api/likes/' + T1 + '?brief=1')).status, 200)
  await h.stop()
  await sleep(5)
  fs.renameSync(path.join(h.dir, 'person.log'), path.join(h.dir, 'person.log.moved-' + Date.now()))
  h = await phoneCore(base, { sources: sources() })
  assert.equal(homeOf(h), PRINCIPAL)
  const st = await h.get('/s/0000/api/library?delta=1')
  assert.deepEqual([st.userVersion, st.epochs.user], [0, ZERO])
  // The newest moved log only, once the next move is done.
  await h.stop()
  writeState(path.join(base, 'state.json'), [])
  h = await phoneCore(base)
  assert.equal((await h.call('PUT', '/s/0000/api/likes/' + T2 + '?brief=1')).status, 200)
  await h.stop()
  h = await phoneCore(base, { sources: sources() })
  const l2 = await h.get('/s/0000/api/library?delta=1')
  assert.equal((await h.call('POST', '/local/phone/moved', { body: { to: PRINCIPAL, uv: l2.userVersion, ue: l2.epochs.user } })).status, 200)
  const kept = fs.readdirSync(h.dir).filter((n) => n.startsWith('person.log'))
  assert.equal(kept.length, 1, 'the newest moved log only: ' + kept.join(', '))
})

test('a log naming another profile is set aside (person.log.wrong-<ms>) and the store starts empty; it never holds the person\'s data', async (t) => {
  const { PhonePerson } = await store()
  const c = cleanup(t)
  const dir = c.dir(tmpDir('mpfy-person-key-'))
  const host = new FakeHost('11'.repeat(16))
  let s = new PhonePerson({ dir, host })
  assert.equal((await ask(s, 'PUT', '/api/likes/' + T1 + '?brief=1')).status, 200)
  assert.equal(s.holds(), true)
  await s.stop()
  host.key = '22'.repeat(16)
  s = new PhonePerson({ dir, host })
  t.after(() => s.stop())
  assert.equal(s.holds(), false, 'another profile\'s log holds nothing of this one')
  assert.deepEqual(s.summary(), { version: 0, epoch: ZERO })
  const lib = await s.libraryPart(null, null, 1)
  assert.deepEqual(lib.likes, [])
  assert.equal((await ask(s, 'PUT', '/api/likes/' + T2 + '?brief=1')).status, 200)
  const names = fs.readdirSync(dir).filter((n) => n.startsWith('person.log'))
  assert.equal(names.length, 2)
  assert.ok(names.some((n) => /^person\.log\.wrong-\d+$/.test(n)), names.join(', '))
  assert.deepEqual((await s.libraryPart(null, null, 1)).likes.map((l) => l.id), [T2])
})

// ------------------------------------------------------------------ the log's own

// File calls that count the bytes read, and can fail a write or the cut after it.
function countingFs () {
  const f = { read: 0, fail: null, cutFails: 0 }
  f.fs = new Proxy(fs, {
    get (target, k) {
      if (k === 'readSync') {
        return (fd, buf, off, len, pos) => {
          const n = fs.readSync(fd, buf, off, len, pos)
          f.read += n
          return n
        }
      }
      if (k === 'writeSync') {
        return (fd, buf, off, len, pos) => {
          const x = f.fail
          if (x !== null) {
            f.fail = null
            if (x.code) throw Object.assign(new Error(x.code), { code: x.code })
            return fs.writeSync(fd, buf, off, x.short, pos)
          }
          return fs.writeSync(fd, buf, off, len, pos)
        }
      }
      if (k === 'ftruncateSync' || k === 'truncateSync') {
        return (...args) => {
          if (f.cutFails > 0) {
            f.cutFails--
            throw Object.assign(new Error('EIO'), { code: 'EIO' })
          }
          return target[k](...args)
        }
      }
      return target[k]
    }
  })
  return f
}

test('a start reads the header and the end of the log only, and says the version and the epoch the whole replay gives', async (t) => {
  const { PhonePerson } = await store()
  const c = cleanup(t)
  const dir = c.dir(tmpDir('mpfy-person-peek-'))
  const host = new FakeHost()
  let s = new PhonePerson({ dir, host })
  for (let k = 0; k < 2; k++) await ask(s, 'POST', '/api/likes', { add: Array.from({ length: 4000 }, (_, i) => T(k * 4000 + i + 1)) })
  for (let i = 0; i < 20; i++) await ask(s, 'POST', '/api/played', { trackId: T(i + 1) })
  await s.compact()
  for (let k = 0; k < 3; k++) {
    await s.stop()
    s = new PhonePerson({ dir, host })
    for (let i = 0; i < 30; i++) await ask(s, 'PUT', '/api/likes/' + T(9000 + k * 100 + i) + '?brief=1')
  }
  const whole = s.summary()
  await s.stop()
  const size = fs.statSync(path.join(dir, 'person.log')).size
  const counting = countingFs()
  s = new PhonePerson({ dir, host, fs: counting.fs })
  t.after(() => s.stop())
  assert.equal(s.holds(), true)
  const peeked = s.summary()
  assert.ok(counting.read < size / 4, 'read ' + counting.read + ' of ' + size + ' bytes')
  assert.deepEqual(peeked, whole)
  // A client holding the versions now: nothing moved, and the log is not read for it.
  const read = counting.read
  const same = await s.libraryPart(whole.version, whole.epoch, 1)
  assert.deepEqual([same.delta, same.playlists, same.likes, same.recents, same.covers], [true, { changed: [], removed: [] }, { added: [], removed: [] }, null, {}])
  assert.equal(counting.read, read)
  // The same number under an epoch this log never had (another log's): the whole part.
  const other = await s.libraryPart(whole.version, 'f'.repeat(16), 1)
  assert.equal(other.delta, false)
  assert.equal(other.likes.length, 8090)
  await s.ready()
  assert.ok(counting.read > size, 'read whole once a request needs the person')
  assert.deepEqual(s.summary(), whole, 'the replay agrees')
})

test('a crash at any point of a write: a last line cut short is dropped; a line that does not parse, or out of sequence, ends the trusted part (the rest kept aside); a short or failed write changes nothing; a failed cut back refuses every change until a restart', async (t) => {
  const { PhonePerson } = await store()
  const c = cleanup(t)
  const dir = c.dir(tmpDir('mpfy-person-crash-'))
  const host = new FakeHost()
  const file = path.join(dir, 'person.log')
  let s = new PhonePerson({ dir, host })
  for (let i = 1; i <= 5; i++) await ask(s, 'PUT', '/api/likes/' + T(i) + '?brief=1')
  const v5 = s.summary()
  await s.stop()
  const whole = fs.readFileSync(file)
  // Half a line at the end.
  fs.appendFileSync(file, '{"v":' + (v5.version + 1) + ',"o":"l","id":"')
  s = new PhonePerson({ dir, host })
  await s.ready()
  assert.deepEqual(s.summary(), v5)
  assert.ok(fs.readFileSync(file).equals(whole), 'cut back to its whole lines')
  await s.stop()
  // A line that does not parse, then lines after it: kept aside, the log cut there.
  fs.appendFileSync(file, 'not json\n{"v":' + (v5.version + 1) + ',"o":"l","id":"' + T(9) + '","at":1}\n')
  s = new PhonePerson({ dir, host })
  await s.ready()
  assert.deepEqual(s.summary(), v5)
  assert.ok(fs.readFileSync(file).equals(whole))
  assert.ok(fs.readdirSync(dir).some((n) => /^person\.log\.cut-\d+$/.test(n)), 'the rest kept aside')
  await s.stop()
  // A version out of sequence.
  fs.appendFileSync(file, '{"v":' + (v5.version + 3) + ',"o":"l","id":"' + T(9) + '","at":1}\n')
  s = new PhonePerson({ dir, host })
  await s.ready()
  assert.deepEqual(s.summary(), v5)
  assert.deepEqual((await s.libraryPart(null, null, 0)).likes.map((l) => l.id), [T(5), T(4), T(3), T(2), T(1)])
  await s.stop()

  // Writes that fail: nothing applied, the file as it was.
  const f = countingFs()
  s = new PhonePerson({ dir, host, fs: f.fs })
  await s.ready()
  const before = fs.readFileSync(file)
  f.fail = { short: 7 }
  let r = await ask(s, 'PUT', '/api/likes/' + T(20) + '?brief=1')
  assert.deepEqual([r.status, r.data.code], [507, 'disk_full'])
  f.fail = { code: 'ENOSPC' }
  r = await ask(s, 'POST', '/api/playlists', { id: P.one })
  assert.deepEqual([r.status, r.data.code], [507, 'disk_full'])
  f.fail = { code: 'EIO' }
  r = await ask(s, 'POST', '/api/played', { trackId: T(1) })
  assert.equal(r.status, 500)
  assert.equal(r.headers['X-MPfy-User-Version'], undefined, 'a refusal carries no version')
  assert.ok(fs.readFileSync(file).equals(before), 'nothing written')
  assert.deepEqual(s.summary(), v5)
  const lib = await s.libraryPart(null, null, 0)
  assert.deepEqual([lib.likes.length, lib.playlists.length, lib.recents.length], [5, 0, 0], 'nothing applied')
  // The cut back fails too: no change is taken until a restart.
  f.fail = { short: 3 }
  f.cutFails = 2
  r = await ask(s, 'PUT', '/api/likes/' + T(21) + '?brief=1')
  assert.equal(r.status, 507)
  r = await ask(s, 'PUT', '/api/likes/' + T(22) + '?brief=1')
  assert.equal(r.status, 500, 'broken until a restart')
  await s.stop()
  s = new PhonePerson({ dir, host })
  t.after(() => s.stop())
  await s.ready()
  assert.deepEqual(s.summary(), v5, 'the half line dropped at the next start')
  assert.equal((await ask(s, 'PUT', '/api/likes/' + T(22) + '?brief=1')).status, 200)
})

test('compaction while changes keep coming: every change made meanwhile is in the new file; the file replays to the live state at every moment', async (t) => {
  const { PhonePerson } = await store()
  const c = cleanup(t)
  const dir = c.dir(tmpDir('mpfy-person-compact-'))
  const host = new FakeHost()
  const slow = new Proxy(fs, {
    get (target, k) {
      if (k === 'fsync') return (fd, cb) => setTimeout(() => target.fsync(fd, cb), 15)
      return target[k]
    }
  })
  const limits = { compactMin: 2000, compactOpenMin: 1000, sliceBytes: 300, keepRoundBytes: 4000 }
  let s = new PhonePerson({ dir, host, fs: slow, limits })
  t.after(() => s.stop())
  const r = rng(11)
  const pick = (a) => a[Math.floor(r() * a.length)]
  const tracks = Array.from({ length: 40 }, (_, i) => T(i + 1))
  const lists = ['a0a0a0a0a0a0a0a0', 'b1b1b1b1b1b1b1b1']
  let during = 0
  for (let i = 0; i < 400; i++) {
    const x = r()
    const pl = pick(lists)
    if (x < 0.3) await ask(s, 'PUT', '/api/likes/' + pick(tracks) + '?brief=1')
    else if (x < 0.45) await ask(s, 'DELETE', '/api/likes/' + pick(tracks) + '?brief=1')
    else if (x < 0.5) await ask(s, 'POST', '/api/playlists', { id: pl })
    else if (x < 0.65) await ask(s, 'POST', '/api/playlists/' + pl + '/tracks', { trackIds: [pick(tracks), pick(tracks)] })
    else if (x < 0.72) await ask(s, 'DELETE', '/api/playlists/' + pl + '/tracks', { indexes: [0] })
    else if (x < 0.75) await ask(s, 'DELETE', '/api/playlists/' + pl)
    else if (x < 0.8) await ask(s, 'PUT', '/api/cover-for/playlist/' + pl + '?size=small', fakeJpeg(1 + Math.floor(r() * 3), 800))
    else await ask(s, 'POST', '/api/played', { trackId: pick(tracks) })
    if (s.compacting) during++
    if (i % 5 === 0) {
      // What is on disk now (a new snapshot with the lines written while it was made, or the
      // file a compaction under way will replace) replays to the live state.
      const copy = c.dir(tmpDir('mpfy-person-copy-'))
      fs.copyFileSync(path.join(dir, 'person.log'), path.join(copy, 'person.log'))
      const other = new PhonePerson({ dir: copy, host })
      await other.ready()
      assert.deepEqual(other.summary(), s.summary(), 'step ' + i)
      assert.equal(JSON.stringify(await other.libraryPart(null, null, 1)), JSON.stringify(await s.libraryPart(null, null, 1)), 'step ' + i)
      await other.stop()
    }
    // Changes at the pace of a person, quicker than any: a compaction's rounds still end.
    await sleep(r() < 0.5 ? 1 : 0)
  }
  assert.ok(during > 20, 'changes made while a compaction ran: ' + during)
  assert.ok(s.compactions > 3, 'compactions: ' + s.compactions)
  await s.settled()
  const live = JSON.stringify(await s.libraryPart(null, null, 1))
  const sum = s.summary()
  await s.stop()
  s = new PhonePerson({ dir, host, limits })
  await s.ready()
  assert.deepEqual(s.summary(), sum)
  assert.equal(JSON.stringify(await s.libraryPart(null, null, 1)), live)
})

// A client as the page keeps the person's part of one source: removals first, then
// changes in place and additions at the end, likes as the newest.
class Client {
  constructor () {
    this.uv = null
    this.ue = null
    this.playlists = new Map()
    this.likes = new Map()
    this.recents = []
    this.covers = {}
  }

  apply (a) {
    if (a.delta) {
      for (const id of a.playlists.removed) this.playlists.delete(id)
      // One held keeps its place, one not held goes at the end.
      for (const p of a.playlists.changed) this.playlists.set(p.id, p)
      for (const id of a.likes.removed) this.likes.delete(id)
      for (const l of a.likes.added) {
        this.likes.delete(l.id)
        this.likes.set(l.id, l.at)
      }
      if (a.recents !== null) this.recents = a.recents
      for (const [k, v] of Object.entries(a.covers)) {
        if (v === null) delete this.covers[k]
        else this.covers[k] = v
      }
    } else {
      this.playlists = new Map(a.playlists.map((p) => [p.id, p]))
      this.likes = new Map([...a.likes].reverse().map((l) => [l.id, l.at]))
      this.recents = a.recents
      this.covers = { ...a.covers }
    }
    this.uv = a.version
    this.ue = a.epoch
  }

  view () {
    return {
      playlists: [...this.playlists.values()],
      likes: [...this.likes].reverse().map(([id, at]) => ({ id, at })),
      recents: this.recents,
      covers: sorted(this.covers)
    }
  }
}
// A map of covers says nothing by its order.
const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)))

test('a client applying the deltas holds the whole person part after every step of random histories, with restarts and compactions', async (t) => {
  const { PhonePerson } = await store()
  const c = cleanup(t)
  const dir = c.dir(tmpDir('mpfy-person-delta-'))
  const host = new FakeHost()
  const limits = { compactMin: 4000, compactOpenMin: 2000 }
  let s = new PhonePerson({ dir, host, limits })
  t.after(() => s.stop())
  const r = rng(23)
  const pick = (a) => a[Math.floor(r() * a.length)]
  const tracks = Array.from({ length: 25 }, (_, i) => T(i + 1))
  const lists = ['a0a0a0a0a0a0a0a0', 'b1b1b1b1b1b1b1b1', 'c2c2c2c2c2c2c2c2']
  const clients = [new Client(), new Client(), new Client()]
  let deltas = 0
  for (let i = 0; i < 500; i++) {
    const x = r()
    const pl = pick(lists)
    if (x < 0.25) await ask(s, 'PUT', '/api/likes/' + pick(tracks) + '?brief=1')
    else if (x < 0.4) await ask(s, 'DELETE', '/api/likes/' + pick(tracks) + '?brief=1')
    else if (x < 0.45) await ask(s, 'POST', '/api/likes', { add: [pick(tracks), pick(tracks)], remove: [pick(tracks)] })
    else if (x < 0.5) await ask(s, 'POST', '/api/playlists', { id: pl })
    else if (x < 0.6) await ask(s, 'POST', '/api/playlists/' + pl + '/tracks', { trackIds: [pick(tracks)] })
    else if (x < 0.65) await ask(s, 'DELETE', '/api/playlists/' + pl + '/tracks', { indexes: [0] })
    else if (x < 0.68) await ask(s, 'DELETE', '/api/playlists/' + pl)
    else if (x < 0.72) await ask(s, 'PUT', '/api/cover-for/playlist/' + pl + '?size=large', fakeJpeg(1 + Math.floor(r() * 3), 800))
    else if (x < 0.74) await ask(s, 'DELETE', '/api/cover-for/playlist/' + pl)
    else if (x < 0.9) await ask(s, 'POST', '/api/played', { trackId: pick(tracks) })
    else if (x < 0.95) {
      await s.stop()
      s = new PhonePerson({ dir, host, limits })
    } else await s.compact()
    // Each client asks now and then; one of them always.
    const full = await s.libraryPart(null, null, 1)
    const want = JSON.stringify({ playlists: full.playlists, likes: full.likes, recents: full.recents, covers: sorted(full.covers) })
    for (const [k, cl] of clients.entries()) {
      if (k > 0 && r() < 0.6) continue
      const a = await s.libraryPart(cl.uv, cl.ue, 1)
      if (a.delta) deltas++
      cl.apply(a)
      assert.equal(JSON.stringify(cl.view()), want, 'step ' + i + ', client ' + k)
    }
  }
  assert.ok(deltas > 300, 'deltas: ' + deltas)
})

// ------------------------------------------------------------------ playlist covers

// A JPEG with the parts a source leaves out of the cover id (APP1, COM) and those it keeps.
function jpeg (exif) {
  const seg = (marker, body) => Buffer.concat([Buffer.from([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 255]), body])
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')),
    seg(0xe1, Buffer.from('Exif\0\0' + exif, 'latin1')),
    seg(0xfe, Buffer.from('commento ' + exif, 'latin1')),
    seg(0xdb, Buffer.alloc(65, 3)),
    Buffer.from([0xff, 0xda, 0, 8, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0xff, 0xd9])
  ])
}

function png (text) {
  const chunk = (type, body) => {
    const b = Buffer.alloc(12 + body.length)
    b.writeUInt32BE(body.length, 0)
    b.write(type, 4, 'latin1')
    body.copy(b, 8)
    return b
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', Buffer.alloc(13, 1)), chunk('tEXt', Buffer.from('Nota\0' + text, 'latin1')), chunk('IDAT', Buffer.alloc(20, 7)), chunk('IEND', Buffer.alloc(0))])
}

function webp (exif) {
  const chunk = (type, body) => {
    const b = Buffer.alloc(8 + body.length + (body.length & 1))
    b.write(type, 0, 'latin1')
    b.writeUInt32LE(body.length, 4)
    body.copy(b, 8)
    return b
  }
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), chunk('VP8 ', Buffer.alloc(31, 9)), chunk('EXIF', Buffer.from(exif, 'latin1'))])
  const head = Buffer.alloc(8)
  head.write('RIFF', 0, 'latin1')
  head.writeUInt32LE(body.length, 4)
  return Buffer.concat([head, body])
}

const sourceCoverId = (bytes, ext) => {
  const h = crypto.createHash('sha256')
  for (const part of coverHashParts(bytes, ext)) h.update(part)
  return h.digest('hex').slice(0, 24)
}

test('playlist covers: the id a source gives the picture (metadata left out), kept once in person-covers, released when nothing names it; 415 for bytes that are no picture, 413 above 8 MB', async (t) => {
  const { PhonePerson, coverIdOf } = await store()
  const c = cleanup(t)
  const dir = c.dir(tmpDir('mpfy-person-covers-'))
  const s = new PhonePerson({ dir, host: new FakeHost() })
  t.after(() => s.stop())
  for (const [bytes, ext] of [[jpeg('a'), 'jpg'], [jpeg('bb'), 'jpg'], [png('uno'), 'png'], [png('due'), 'png'], [webp('x'), 'webp'], [webp('yy'), 'webp'], [fakeJpeg(3, 900), 'jpg'], [Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 1]), 'jpg']]) {
    assert.equal(coverIdOf(bytes), sourceCoverId(bytes, ext), ext)
  }
  assert.equal(coverIdOf(jpeg('a')), coverIdOf(jpeg('ccc')), 'the EXIF and the comment are not the picture')
  await ask(s, 'POST', '/api/playlists', { id: P.one })
  await ask(s, 'POST', '/api/playlists', { id: P.trip })
  const covers = path.join(dir, 'person-covers')
  let r = await ask(s, 'PUT', '/api/cover-for/playlist/' + P.one + '?size=large', jpeg('a'))
  assert.equal(r.status, 200)
  const idA = coverIdOf(jpeg('a'))
  assert.deepEqual(r.data, { covers: { track: {}, album: {}, playlist: { [P.one]: { small: null, large: idA } } } })
  assert.ok(r.headers['X-MPfy-User-Version'])
  assert.ok(fs.readFileSync(path.join(covers, idA + '.jpg')).equals(jpeg('a')))
  // The same picture for another playlist: one file.
  r = await ask(s, 'PUT', '/api/cover-for/playlist/' + P.trip + '?size=small', jpeg('zz'))
  assert.equal(r.data.covers.playlist[P.trip].small, idA)
  assert.equal(fs.readdirSync(covers).length, 1)
  // Replaced on one: still named by the other.
  r = await ask(s, 'PUT', '/api/cover-for/playlist/' + P.one + '?size=large', png('uno'))
  assert.equal(r.status, 200)
  assert.ok(fs.existsSync(path.join(covers, idA + '.jpg')))
  r = await ask(s, 'DELETE', '/api/cover-for/playlist/' + P.trip)
  assert.deepEqual(r.data.covers.playlist, { [P.one]: { small: null, large: coverIdOf(png('uno')) } })
  assert.equal(fs.existsSync(path.join(covers, idA + '.jpg')), false, 'released: nothing names it')
  r = await ask(s, 'DELETE', '/api/playlists/' + P.one)
  assert.equal(r.status, 200)
  assert.deepEqual(fs.readdirSync(covers), [], 'a deleted playlist releases its cover')
  // Refusals, as a source's.
  await ask(s, 'POST', '/api/playlists', { id: P.gone })
  r = await ask(s, 'PUT', '/api/cover-for/playlist/' + P.gone + '?size=large', Buffer.from('non una immagine'))
  assert.deepEqual([r.status, r.data.error], [415, "L'immagine non e' un JPEG, PNG o WebP"])
  r = await ask(s, 'PUT', '/api/cover-for/playlist/' + P.gone + '?size=large', Buffer.concat([jpeg('a'), Buffer.alloc(8 * 1024 * 1024)]))
  assert.equal(r.status, 413)
  r = await ask(s, 'PUT', '/api/cover-for/playlist/' + P.gone + '?size=huge', jpeg('a'))
  assert.deepEqual([r.status, r.data.error], [400, 'Dimensione non valida'])
  r = await ask(s, 'PUT', '/api/cover-for/playlist/' + P.one + '?size=small', jpeg('a'))
  assert.deepEqual([r.status, r.data.error], [404, 'Playlist non trovata'])
  r = await ask(s, 'GET', '/api/cover-for/playlist/' + P.gone)
  assert.equal(r.status, 404)
})

test('the limits and rules are the source\'s; the store is portable (no Node globals)', async () => {
  const m = await store()
  for (const k of ['MAX_RECENTS', 'MAX_HISTORY', 'RECENTS_PAGE', 'MAX_RECENTS_PAGE', 'MAX_LIKES', 'MAX_PLAYLISTS', 'MAX_PLAYLIST_ENTRIES', 'MAX_BULK_LIKES']) {
    assert.equal(m[k], serverUsers[k], k)
  }
  const code = fs.readFileSync(new URL('../client-core/phone-person.js', import.meta.url), 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
  for (const re of [/\bBuffer\b/, /\bprocess\./, /\bnew URL\b/, /\bTextEncoder\b/, /\bTextDecoder\b/, /from 'node:/, /\bsetImmediate\b/, /\bperformance\b/]) {
    assert.doesNotMatch(code, re)
  }
})
