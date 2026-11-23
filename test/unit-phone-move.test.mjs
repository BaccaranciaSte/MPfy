// The move of the person's data from the phone store to the first real source: a real
// source in this process (createMPfy, on a local HyperDHT testnet) and a core with
// phone music whose store holds playlists, likes in more than one batch, plays and a
// playlist cover. The pass the page runs (here as the page runs it: the store's person
// part read whole with its versions, the principal copy, the plays of the last 30 days
// less one hour, then POST /local/phone/moved) is cut after every one of its writes and
// before and after the last request, the core and the page killed there, and run again
// from a new start: the source ends with each playlist once, each like once, each play
// within 30 days once at its own time, each cover once, what it held before kept, and
// the phone store empty. A like that reaches the store during a pass is kept (the move
// answers 409 and the pass runs again); after the move a like sent to the phone's
// address lands on the principal.

import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import createTestnet from 'hyperdht/testnet.js'
import { createMPfy } from '../server/app.mjs'
import { createClientCore } from '../client-core/index.js'
import { tmpDir, rmDir, request, json, waitFor, fakeJpeg } from './helpers.mjs'

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web')
const DAY = 24 * 3600 * 1000
const HOUR = 3600 * 1000
const BULK = 5000
const ZERO = '0000000000000000'
const T = (n) => n.toString(16).padStart(24, '0')
const PL = { sea: 'a1a1a1a1a1a1a1a1', hills: 'b2b2b2b2b2b2b2b2', empty: 'c3c3c3c3c3c3c3c3', theirs: 'f1f1f1f1f1f1f1f1' }
const LIKES = Array.from({ length: BULK + 3 }, (_, i) => T(10000 + i))

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

class Killed extends Error {}

async function must (pending, what = '') {
  const res = await pending
  assert.ok(res.status >= 200 && res.status < 300, what + ' answered ' + res.status + ': ' + res.body.toString().slice(0, 200))
  return res
}

// A core with phone music on the testnet; `shift` moves the phone's clock (plays made long ago).
async function startCore (w) {
  const core = createClientCore({
    statePath: w.statePath,
    webRoot: WEB,
    port: 0,
    dht: node(),
    deviceName: 'Telefono di prova',
    phone: { dir: w.statePath + '.phone', send: () => {}, now: () => Date.now() + w.shift, lookups: { fillDelayMs: 3600000 } }
  })
  const { port } = await core.start()
  return {
    core,
    port,
    call: (method, p, opts = {}) => request(port, method, p, { timeout: 60000, ...opts }),
    get: async (p) => {
      const res = await must(request(port, 'GET', p, { timeout: 60000 }), 'GET ' + p)
      return json(res)
    },
    stop: () => core.stop()
  }
}

/**
 * A new world: a source whose claim window is open, a core with a profile, the phone
 * store filled while no source exists, then the source added (the principal, its owner),
 * which already holds a like and a playlist of the person.
 */
async function world (t) {
  const w = { dirs: [tmpDir('mpfy-move-src-'), tmpDir('mpfy-move-core-')], shift: 0, app: null, h: null }
  w.statePath = path.join(w.dirs[1], 'state.json')
  w.phoneDir = w.statePath + '.phone'
  t.after(async () => {
    if (w.h !== null) await w.h.stop()
    if (w.app !== null) await w.app.close()
    for (const d of w.dirs) rmDir(d)
  })
  w.app = await createMPfy({ dataDir: w.dirs[0], port: 0, adminPort: 0, p2p: true, waitForDht: true, dht: node(), ffmpeg: null, fpcalc: null, sevenZip: null, debounceMs: 10, name: 'Fonte di casa' })
  w.app.people.openClaim(30)
  w.h = await startCore(w)
  const h = w.h
  await must(h.call('POST', '/local/profile', { body: { name: 'Prova' } }), 'the profile')
  const s = (method, p, body) => must(h.call(method, '/s/0000' + p, { body }), method + ' ' + p)

  // Plays: one 40 days ago, one at 29 days and 23:30 (inside 30 days, outside the hour of
  // margin), one at 29 and a half days, two recent (one played offline two hours ago).
  w.plays = []
  for (const [n, ago, body] of [[900, 40 * DAY, {}], [901, 30 * DAY - 30 * 60 * 1000, {}], [902, 29.5 * DAY, { context: { type: 'album', id: '65635b422fc84691' } }], [903, 0, { context: { type: 'playlist', id: PL.sea } }], [904, 0, { at: Date.now() - 2 * HOUR }]]) {
    w.shift = -ago
    await s('POST', '/api/played', { trackId: T(n), ...body })
  }
  w.shift = 0
  await s('POST', '/api/playlists', { id: PL.sea, name: 'Mare', description: 'Estate' })
  await s('POST', '/api/playlists/' + PL.sea + '/tracks', { trackIds: [T(1), T(2), T(3), T(2)] })
  await s('POST', '/api/playlists', { id: PL.hills, name: 'Colline' })
  await s('POST', '/api/playlists/' + PL.hills + '/tracks', { trackIds: [T(4), T(1)] })
  await s('POST', '/api/playlists', { id: PL.empty, name: 'Vuota' })
  await s('POST', '/api/likes', { add: LIKES.slice(0, BULK) })
  await s('POST', '/api/likes', { add: LIKES.slice(BULK) })
  await s('PUT', '/api/cover-for/playlist/' + PL.sea + '?size=large', fakeJpeg(61, 3000))
  const cov = json(await s('PUT', '/api/cover-for/playlist/' + PL.sea + '?size=small', fakeJpeg(62, 1200)))
  w.cover = cov.covers.playlist[PL.sea]
  w.before = await h.get('/s/0000/api/library?delta=1')

  // The first source: the principal, owned by this profile.
  const added = await must(h.call('POST', '/local/sources', { body: { code: w.app.code }, timeout: 90000 }), 'the source')
  w.to = json(added).source.id
  await connected(w)
  const to = (method, p, body) => must(h.call(method, '/s/' + w.to + p, { body }), method + ' ' + p)
  await to('PUT', '/api/likes/' + T(950) + '?brief=1')
  await to('POST', '/api/playlists', { id: PL.theirs, name: 'Della fonte' })
  return w
}

async function connected (w) {
  await waitFor(async () => {
    const list = await w.h.get('/local/sources')
    const s = list.sources.find((x) => x.id === w.to)
    return s !== undefined && s.connected && s.principal
  }, { timeout: 60000, interval: 100, what: 'the link to the source' })
}

// The plays of a person part, newest first, page by page, down to `from` (ms).
async function plays (h, prefix, from) {
  const out = []
  let before = null
  for (;;) {
    const page = await h.get(prefix + '/api/recents?limit=200' + (before !== null ? '&before=' + before : ''))
    out.push(...page.recents)
    if (!page.more || page.recents.length === 0) break
    before = page.recents[page.recents.length - 1].at
    if (before < from) break
  }
  return out.filter((r) => r.at >= from)
}

/**
 * One pass of the move, as the page runs it. `step(label)` after each write and around
 * the last request; `during()` once the copy is made, before the move is asked. True when
 * the move is done.
 */
async function movePass (w, step, during = null) {
  const h = w.h
  const to = w.to
  const at = (method, p, body) => must(h.call(method, '/s/' + to + p, { body }), method + ' ' + p)
  // 1. The store's person part, whole, and its versions.
  const mine = await h.get('/s/0000/api/library?delta=1')
  const uv = mine.userVersion
  const ue = mine.epochs.user
  // 2. The principal copy: playlists with their own ids (made, or updated where they are),
  //    likes the principal lacks oldest first in bulk, playlist covers.
  const dest = await h.get('/s/' + to + '/api/library')
  const destLikes = new Set(dest.likes.map((l) => l.id))
  for (const pl of [...mine.playlists].sort((a, b) => a.createdAt - b.createdAt)) {
    if (dest.playlists.some((p) => p.id === pl.id)) {
      await at('PATCH', '/api/playlists/' + pl.id, { name: pl.name, description: pl.description, trackIds: pl.trackIds })
    } else {
      await at('POST', '/api/playlists', { name: pl.name, description: pl.description, id: pl.id })
      if (pl.trackIds.length > 0) await at('PATCH', '/api/playlists/' + pl.id, { trackIds: pl.trackIds })
    }
    await step('playlist ' + pl.name)
  }
  const likes = [...mine.likes].sort((a, b) => a.at - b.at).filter((l) => !destLikes.has(l.id)).map((l) => l.id)
  for (let i = 0; i < likes.length; i += BULK) {
    await at('POST', '/api/likes', { add: likes.slice(i, i + BULK) })
    await step('likes ' + i)
  }
  for (const [id, c] of Object.entries(mine.covers.playlist)) {
    const have = dest.covers.playlist[id]
    if (have && have.large === c.large && have.small === c.small) continue
    for (const size of ['large', 'small']) {
      const img = await must(h.call('GET', '/s/0000/api/cover/' + c[size] + '?size=' + size), 'the cover ' + size)
      await at('PUT', '/api/cover-for/playlist/' + id + '?size=' + size, img.body)
      await step('cover ' + size)
    }
  }
  // 3. The plays of the last 30 days less one hour, oldest first, but those the principal holds.
  const from = Date.now() - 30 * DAY + HOUR
  const send = (await plays(h, '/s/0000', from)).reverse()
  const key = (r) => r.trackId + '|' + r.at + '|' + JSON.stringify(r.context)
  const held = new Set(send.length > 0 ? (await plays(h, '/s/' + to, send[0].at)).map(key) : [])
  for (const r of send) {
    if (held.has(key(r))) continue
    await at('POST', '/api/played', { trackId: r.trackId, at: r.at, context: r.context })
    await step('play ' + r.trackId)
  }
  if (during !== null) await during()
  // 4. The move asked with the versions read at the start.
  await step('before moved')
  const res = await h.call('POST', '/local/phone/moved', { body: { to, uv, ue } })
  await step('after moved')
  if (res.status === 409) {
    assert.equal(json(res).code, 'changed')
    return false
  }
  assert.equal(res.status, 200, res.body.toString())
  return true
}

// Passes while the store is the home and the principal is up, as the page does at a start.
async function move (w, step = async () => {}, during = null) {
  let passes = 0
  while ((await w.h.get('/local/sources')).phone.home) {
    assert.ok(++passes <= 3, 'the move ends')
    if (await movePass(w, step, passes === 1 ? during : null)) break
  }
  return passes
}

async function check (w, { extraLikes = [] } = {}) {
  const h = w.h
  const lib = await h.get('/s/' + w.to + '/api/library')
  // Each playlist once, as it was on the phone; the source's own kept.
  const ids = lib.playlists.map((p) => p.id)
  assert.deepEqual([...ids].sort(), [PL.sea, PL.hills, PL.empty, PL.theirs].sort(), 'each playlist once')
  for (const pl of w.before.playlists) {
    const there = lib.playlists.find((p) => p.id === pl.id)
    assert.deepEqual([there.name, there.description, there.trackIds], [pl.name, pl.description, pl.trackIds], pl.name)
  }
  // Each like once; the source's own kept.
  const liked = lib.likes.map((l) => l.id)
  assert.equal(new Set(liked).size, liked.length)
  assert.deepEqual(new Set(liked), new Set([...LIKES, T(950), ...extraLikes]))
  // Each play within 30 days less an hour once, at its own time and with its context.
  const want = w.before.recents.filter((r) => r.at >= Date.now() - 30 * DAY + HOUR)
  assert.deepEqual(want.map((r) => r.trackId).sort(), [T(902), T(903), T(904)])
  const theirs = await plays(h, '/s/' + w.to, 0)
  assert.deepEqual(theirs, want, 'each play once, at its own time')
  // Each cover once, the very pictures.
  assert.deepEqual(lib.covers.playlist, { [PL.sea]: w.cover })
  // The phone store is empty, and no longer the home.
  const st = await h.get('/local/sources')
  assert.equal(st.phone.home, false)
  const mine = await h.get('/s/0000/api/library?delta=1')
  assert.deepEqual([mine.userVersion, mine.epochs.user, mine.playlists, mine.likes, mine.recents], [0, ZERO, [], [], []])
  const names = fs.readdirSync(w.phoneDir).filter((n) => n.startsWith('person.log'))
  assert.equal(names.length, 1)
  assert.match(names[0], /^person\.log\.moved-\d+$/)
}

test('the move, killed after each of its writes and before and after the last request, then run again from a new start: everything once on the source, the phone store empty', { timeout: 900000 }, async (t) => {
  // A whole pass first: how many steps it has.
  const w0 = await world(t)
  assert.equal((await w0.h.get('/local/sources')).phone.home, true, 'the move is due')
  let steps = 0
  const labels = []
  const passes = await move(w0, async (label) => {
    steps++
    labels.push(label)
  })
  assert.equal(passes, 1)
  await check(w0)
  assert.deepEqual(labels, ['playlist Mare', 'playlist Colline', 'playlist Vuota', 'likes 0', 'likes 5000', 'cover large', 'cover small', 'play ' + T(902), 'play ' + T(904), 'play ' + T(903), 'before moved', 'after moved'])
  // After the move, the person's data sent to the phone's address lands on the principal.
  await must(w0.h.call('PUT', '/s/0000/api/likes/' + T(888) + '?brief=1'), 'a like after the move')
  const lib = await w0.h.get('/s/' + w0.to + '/api/library')
  assert.ok(lib.likes.some((l) => l.id === T(888)), 'the like is on the principal')
  assert.equal(fs.existsSync(path.join(w0.phoneDir, 'person.log')), false, 'and not in the store')
  await w0.h.stop()
  w0.h = null
  await w0.app.close()
  w0.app = null

  for (let k = 1; k <= steps; k++) {
    await t.test('killed after "' + labels[k - 1] + '"', async (tt) => {
      const w = await world(tt)
      let n = 0
      await assert.rejects(move(w, async (label) => {
        if (++n === k) throw new Killed(label)
      }), Killed)
      // The core and the page die there; a new start runs the move again.
      await w.h.stop()
      w.h = null
      w.h = await startCore(w)
      await connected(w)
      await move(w)
      await check(w)
    })
  }
})

test('a like that reaches the phone store during the move is kept: the move answers 409 changed and the pass runs again', { timeout: 300000 }, async (t) => {
  const w = await world(t)
  const passes = await move(w, async () => {}, async () => {
    await must(w.h.call('PUT', '/s/0000/api/likes/' + T(777) + '?brief=1'), 'a like during the move')
  })
  assert.equal(passes, 2, 'a second pass')
  await check(w, { extraLikes: [T(777)] })
})
