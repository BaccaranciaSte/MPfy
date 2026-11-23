// The page's library store (web/js/store.js, run in Node) against two real sources of 20,000
// tracks each, end to end. Two devices of the same person: the page (it reads deltas) and an
// app of before the deltas (no `delta`, the whole likes list after a heart). Along the way one
// source is restarted, the other compacted, the first cut by a power cut (its log cut back to
// the bytes on disk at an earlier moment) and the second claimed by a new profile, which merges
// the owner's data into it. At every checkpoint:
// - the page's store equals a store started from nothing on another page (full answers only):
//   every source's view, the union of the songs in its order, every index;
// - the old app's library equals a whole answer of today's form;
// - the page got deltas where nothing forces a whole part (a restart, a compaction) and whole
//   parts where something does (versions lost in a power cut, a person merged into).
// At the end a page started from the first page's IndexedDB (read before the core names the
// sources) asks with what it holds, gets only 304s and equals the first page.
//
// Each source, each page runs in its own process (the store is one per page); this file is all
// of them: `--source <dir> <name>` and `--page <options>` start those, nothing starts the tests.

import test from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import v8 from 'node:v8'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const ROOT = path.resolve(path.dirname(SELF), '..')
const WEB = path.join(ROOT, 'web')
const TRACKS = Number(process.env.MPFY_E2E_TRACKS) || 20000 // per source
const SHARED = TRACKS / 4 // the same files on both sources
const A = 'aaaa1111'
const B = 'bbbb2222'

const mode = process.argv[2]
if (mode === '--source') await sourceMain()
else if (mode === '--page') await pageMain()
else defineTests()

// =================================================================================================
// a source: a real MPfy in its own process, driven by messages
// =================================================================================================

async function sourceMain () {
  const [dir, name] = process.argv.slice(3)
  const { createMPfy } = await import(pathToFileURL(path.join(ROOT, 'server/app.mjs')).href)
  const { testWhoIs } = await import(pathToFileURL(path.join(ROOT, 'test/helpers.mjs')).href)
  const app = await createMPfy({ dataDir: dir, port: 0, adminPort: 0, p2p: false, debounceMs: 10, ffmpeg: null, fpcalc: null, sevenZip: null, name, whoIs: testWhoIs })
  const logs = () => {
    const out = { 'library.log': fileSize(path.join(dir, 'library.log')) }
    for (const f of fs.readdirSync(path.join(dir, 'users'))) if (f.endsWith('.log')) out['users/' + f] = fileSize(path.join(dir, 'users', f))
    return out
  }
  // Nothing moves any more: the media jobs, the lyrics, compactions, merges and sweeps are over.
  const quiet = async () => {
    for (let round = 0; round < 200; round++) {
      const v = app.library.version
      await app.jobs.idle()
      await app.lyrics.idle()
      await app.library.settled()
      await app.users.settled()
      await new Promise((resolve) => setTimeout(resolve, 30))
      if (app.library.version === v) return
    }
  }
  const handlers = {
    quiet,
    admit: ({ key }) => app.clients.add(key, 'Telefono nuovo'),
    // Both logs written again now: the library's and every person's.
    async compact () {
      await quiet()
      const before = logs()
      await app.library.compact()
      for (const key of app.users.keys()) {
        const { user, release } = await app.users.open(key)
        try {
          await user.log.compact()
        } finally {
          release()
        }
      }
      await quiet()
      return { before, after: logs(), head: fs.readFileSync(path.join(dir, 'library.log'), 'utf8').slice(0, 400).split('\n').slice(0, 3) }
    },
    // What is on disk now: every log synced, and the logs of people not loaded closed after their
    // own background sync (at most one per 500 ms).
    async synced () {
      await quiet()
      app.library.flush()
      app.users.flush()
      await new Promise((resolve) => setTimeout(resolve, 700))
      return { logs: logs() }
    },
    async close () {
      await app.close()
      setImmediate(() => process.exit(0))
    }
  }
  process.on('message', async (m) => {
    let reply
    if (process.env.MPFY_E2E_TRACE) console.error('cmd', m.cmd, JSON.stringify(m).slice(0, 200))
    try {
      reply = { value: (await handlers[m.cmd](m.data)) ?? null }
    } catch (err) {
      reply = { error: String((err && err.stack) || err) }
    }
    process.send({ id: m.id, ...reply })
  })
  process.send({ ready: true, http: app.ports.http, admin: app.ports.admin, key: app.serverPublicKey })
}

function fileSize (file) {
  try {
    return fs.statSync(file).size
  } catch {
    return null
  }
}

// =================================================================================================
// a page: the store in Node, with a fake IndexedDB and the sources' answers routed to their ports
// =================================================================================================

async function pageMain () {
  const opts = JSON.parse(process.argv[3])
  const ports = { ...opts.ports }
  const noop = () => {}
  const ls = new Map()
  const el = () => ({ append: noop, appendChild: noop, remove: noop, classList: { add: noop, remove: noop, toggle: noop, contains: () => false }, style: { setProperty: noop }, setAttribute: noop, addEventListener: noop, children: [], firstElementChild: null, querySelector: () => null, querySelectorAll: () => [], dataset: {} })
  const origin = 'http://127.0.0.1:47123'
  globalThis.window = globalThis
  globalThis.addEventListener = noop
  globalThis.matchMedia = () => ({ matches: false, addEventListener: noop })
  globalThis.localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k), key: (i) => [...ls.keys()][i] ?? null, get length () { return ls.size } }
  globalThis.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener: noop, removeEventListener: noop, createElement: el, createElementNS: el, createDocumentFragment: el, body: el(), documentElement: el(), hidden: false }
  globalThis.requestAnimationFrame = (f) => setTimeout(f, 0)
  globalThis.location = { origin, href: origin + '/', pathname: '/' }
  const idb = fakeIndexedDB(opts.idbFile ? v8.deserialize(fs.readFileSync(opts.idbFile)) : new Map())
  idb.install()

  // The library answers, as they came: which parts were deltas.
  let answers = []
  const SOURCES = [
    { id: A, name: 'Uno', principal: true, connected: true, addedAt: 1, role: 'owner', profiles: true },
    { id: B, name: 'Due', principal: false, connected: true, addedAt: 2, role: 'owner', profiles: true }
  ]
  const realFetch = globalThis.fetch
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(typeof input === 'string' ? input : input.url, origin)
    if (u.pathname === '/local/sources') return new Response(JSON.stringify({ sources: SOURCES }), { status: 200, headers: { 'content-type': 'application/json' } })
    const m = /^\/s\/([^/]+)(\/.*)$/.exec(u.pathname)
    if (!m || !ports[m[1]]) return new Response('{}', { status: 404 })
    const { cache, signal, ...rest } = init
    if (process.env.MPFY_E2E_TRACE) console.error('->', init.method || 'GET', m[1], m[2] + u.search)
    const res = await realFetch('http://127.0.0.1:' + ports[m[1]] + m[2] + u.search, rest)
    if (process.env.MPFY_E2E_TRACE) console.error('<-', res.status, m[2])
    const body = await res.arrayBuffer()
    if (m[2] === '/api/library') {
      const head = Buffer.from(body.slice(0, 600)).toString('utf8')
      const d = /"delta":\{"shared":(true|false),"user":(true|false)\}/.exec(head)
      // tracks null: the shared part did not move (no delta needed for it).
      const same = head.includes('},"tracks":null,')
      answers.push({ src: m[1], query: u.search, status: res.status, bytes: body.byteLength, shared: d ? d[1] === 'true' : null, user: d ? d[2] === 'true' : null, same })
    }
    return new Response(res.status === 304 ? null : body, { status: res.status, headers: res.headers })
  }

  const { sources } = await import(pathToFileURL(path.join(WEB, 'js/sources.js')).href)
  const { store } = await import(pathToFileURL(path.join(WEB, 'js/store.js')).href)
  const settle = async () => {
    await store.refresh()
    await store.idle()
    await store.cacheIdle()
  }
  const t0 = Date.now()
  if (opts.idbFile) {
    // The cache read before the core names the sources: the store asks with what it holds.
    await store.init()
    await sources.refresh()
  } else {
    await sources.refresh()
    await store.init()
  }
  await settle()
  const startMs = Date.now() - t0

  const handlers = {
    settle,
    ports: (m) => Object.assign(ports, m.ports),
    answers () {
      const out = answers
      answers = []
      return out
    },
    async call ({ fn, args }) {
      const r = await store[fn](...args)
      return r === undefined ? null : JSON.parse(JSON.stringify(r))
    },
    // A play reported, and the report gone out of the page's outbox (its answer in).
    async played ({ trackId, context }) {
      store.played(trackId, context)
      for (let i = 0; i < 500 && (JSON.parse(localStorage.getItem('mpfy.played.outbox') || '[]').length > 0); i++) await new Promise((resolve) => setTimeout(resolve, 10))
    },
    // A new order for a playlist made from what the page shows now (reversed), with its base.
    async reverse ({ id, name }) {
      const base = store.d.playlists.get(id).trackIds.slice()
      await store.updatePlaylist(id, { name, trackIds: base.slice().reverse(), base })
    },
    async dump ({ file }) {
      await settle()
      const d = dumpStore(store)
      fs.writeFileSync(file, JSON.stringify(d))
      return { songs: store.lib.tracks.length, startMs }
    },
    saveIdb ({ file }) {
      fs.writeFileSync(file, v8.serialize(idb.data))
      return { records: idb.data.size }
    }
  }
  process.on('message', async (m) => {
    let reply
    if (process.env.MPFY_E2E_TRACE) console.error('cmd', m.cmd, JSON.stringify(m).slice(0, 200))
    try {
      reply = { value: (await handlers[m.cmd](m.data)) ?? null }
    } catch (err) {
      reply = { error: String((err && err.stack) || err) }
    }
    process.send({ id: m.id, ...reply })
  })
  process.send({ ready: true, startMs })
}

/**
 * Everything the page shows from the store, in a form two stores can be compared by: each
 * source's view whole, the songs in their order (every field, every version), and every index
 * (maps by key, sets sorted, lists in order; the search text of each song).
 */
function dumpStore (store) {
  const out = {}
  for (const src of [A, B]) {
    out['view ' + src] = canon(store.libOf(src))
    // Nothing in flight at a checkpoint: every change the page made was confirmed by a version.
    out['pending ' + src] = store.pendingOps(src)
  }
  const songs = store.lib.tracks
  out.songs = songs.map((s) => JSON.stringify(canon(s)))
  const { tracks, ...lib } = store.lib
  out.lib = canon(lib)
  const d = store.d
  for (const k of Object.keys(d).sort()) {
    if (k === 'searchText') out['d.searchText'] = songs.map((s) => d.searchText.get(s.id) ?? null)
    else if (k === 'tracks') out['d.tracks'] = [...d.tracks].map(([id, s]) => [id, s.id]).sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
    else out['d.' + k] = canon(d[k])
  }
  return out
}

/** A plain value: object keys sorted, maps by key, sets sorted, typed arrays as lists, no functions. */
function canon (x, stack = new Set()) {
  if (x === null || typeof x !== 'object') return typeof x === 'function' ? undefined : x
  if (stack.has(x)) return '[cycle]'
  stack.add(x)
  let out
  const byKey = (a, b) => (String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0)
  if (x instanceof Map) out = { map: [...x].map(([k, v]) => [k, canon(v, stack)]).sort(byKey) }
  else if (x instanceof Set) out = { set: [...x].map((v) => JSON.stringify(canon(v, stack))).sort() }
  else if (ArrayBuffer.isView(x)) out = Array.from(x)
  else if (Array.isArray(x)) out = x.map((v) => canon(v, stack))
  else {
    out = {}
    for (const k of Object.keys(x).sort()) {
      const v = canon(x[k], stack)
      if (v !== undefined) out[k] = v
    }
  }
  stack.delete(x)
  return out
}

/**
 * A fake IndexedDB: one store, transactions one after the other, kept whole (their writes are
 * seen inside them and land at their end; an abort drops them). `data` holds what landed.
 */
function fakeIndexedDB (data) {
  const noop = () => {}
  let queue = Promise.resolve()
  const inRange = (k, r) => !r || (k >= r.lower && k <= r.upper)
  const copy = (v) => (v === undefined ? undefined : structuredClone(v))
  function transaction (mode) {
    const staged = new Map()
    const t = { mode, oncomplete: null, onerror: null, onabort: null, error: null }
    let done = false
    let pending = 0
    let release
    const start = queue
    queue = new Promise((resolve) => (release = resolve))
    const read = (k) => (staged.has(k) ? staged.get(k) : data.get(k))
    const keys = (r) => {
      const s = new Set([...data.keys()].filter((k) => inRange(k, r)))
      for (const [k, v] of staged) {
        if (!inRange(k, r)) continue
        if (v === undefined) s.delete(k)
        else s.add(k)
      }
      return [...s].sort()
    }
    const finish = () => {
      if (done || pending) return
      done = true
      for (const [k, v] of staged) {
        if (v === undefined) data.delete(k)
        else data.set(k, v)
      }
      release()
      if (t.oncomplete) t.oncomplete()
    }
    t.abort = () => {
      if (done) return
      done = true
      staged.clear()
      t.error = t.error || { name: 'AbortError' }
      release()
      setTimeout(() => t.onabort && t.onabort(), 0)
    }
    const request = (fn) => {
      const req = { result: undefined, onsuccess: null, onerror: null }
      pending++
      start.then(() =>
        setTimeout(() => {
          pending--
          if (done) return
          req.result = fn()
          if (req.onsuccess) req.onsuccess()
          setTimeout(finish, 0)
        }, 0)
      )
      return req
    }
    const s = {
      get: (k) => request(() => copy(read(k))),
      put: (v, k) => request(() => staged.set(k, copy(v))),
      delete: (k) => request(() => staged.set(k, undefined)),
      getAll: (r) => request(() => keys(r).map((k) => copy(read(k)))),
      getAllKeys: (r) => request(() => keys(r))
    }
    t.objectStore = () => s
    start.then(() => setTimeout(finish, 0))
    return t
  }
  const db = { transaction: (name, mode = 'readonly') => transaction(mode), createObjectStore: noop }
  return {
    data,
    install () {
      globalThis.IDBKeyRange = { bound: (lower, upper) => ({ lower, upper }) }
      globalThis.indexedDB = {
        open () {
          const req = { result: db, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null }
          setTimeout(() => {
            if (req.onupgradeneeded) req.onupgradeneeded()
            if (req.onsuccess) req.onsuccess()
          }, 0)
          return req
        }
      }
    }
  }
}

// =================================================================================================
// the test
// =================================================================================================

/** A child of this file, driven by messages: call(cmd, fields) resolves with its answer. */
function child (args, label) {
  // Not a test process of its own: the runner's context stays with this one.
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const proc = fork(SELF, args, { env, execArgv: ['--max-old-space-size=4096'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let out = ''
  proc.stdout.on('data', (d) => (out = (out + d).slice(-20000)))
  proc.stderr.on('data', (d) => (out = (out + d).slice(-20000)))
  let seq = 0
  const waiting = new Map()
  let ready
  const readyP = new Promise((resolve, reject) => {
    ready = resolve
    proc.on('exit', (code) => reject(new Error(label + ' exited ' + code + ' before it was ready:\n' + out)))
  })
  proc.on('message', (m) => {
    if (m.ready) return ready(m)
    const w = waiting.get(m.id)
    if (!w) return
    waiting.delete(m.id)
    if (m.error) w.reject(new Error(label + ': ' + m.error))
    else w.resolve(m.value)
  })
  proc.on('exit', (code) => {
    for (const w of waiting.values()) w.reject(new Error(label + ' exited ' + code + ':\n' + out))
    waiting.clear()
  })
  // A step that hangs fails with what the child said.
  const call = (cmd, fields = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      const timer = setTimeout(() => {
        waiting.delete(id)
        reject(new Error(label + ': ' + cmd + ' ' + JSON.stringify(fields).slice(0, 200) + ' gave no answer in 180 s:\n' + out))
      }, 180000)
      waiting.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        }
      })
      proc.send({ id, cmd, data: fields })
    })
  const exited = new Promise((resolve) => proc.on('exit', resolve))
  return { proc, ready: readyP, call, exited, log: () => out }
}

/**
 * A source's data dir of before the logs (db.json and its files, as an older MPfy left them,
 * every track's tags and lyrics already read): `TRACKS` tracks, the first `SHARED` the same
 * files as the other source's.
 */
async function makeSource (dir, name, { keyOf }) {
  fs.mkdirSync(path.join(dir, 'library'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'lyrics'), { recursive: true })
  const tracks = []
  const writes = []
  for (let i = 0; i < TRACKS; i++) {
    const body = Buffer.from('MPfy, file di prova ' + (i < SHARED ? 'comune' : name) + ' ' + i + ' ' + '.'.repeat(i % 40))
    const id = crypto.createHash('sha256').update(body).digest('hex').slice(0, 24)
    writes.push([path.join(dir, 'library', id + '.mp3'), body])
    tracks.push({ id, fileHash: id, format: 'mp3', size: body.length, title: 'Brano ' + i, artist: 'Artista ' + (i % 700), album: 'Album ' + (i % 2500), trackNo: (i % 8) + 1, discNo: 1, year: 1990 + (i % 30), duration: 150 + (i % 120), bitrate: 192000, sampleRate: 44100, codec: 'mp3', tagless: [], fpState: 'failed', qualityV: 0, addedAt: 1760000000000 + i * 1000, uploaders: ['owner'] })
  }
  let next = 0
  await Promise.all(Array.from({ length: 32 }, async () => {
    while (next < writes.length) {
      const [file, body] = writes[next++]
      await fs.promises.writeFile(file, body)
    }
  }))
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ schema: 3, version: 7, tracks, covers: { track: {}, album: {} }, gone: [] }))
  const lines = ['{"schema":1}']
  for (const t of tracks) lines.push(JSON.stringify([t.id, { kind: null, from: null, key: keyOf(t), lookup: null }]))
  fs.writeFileSync(path.join(dir, 'lyrics', 'index.ndjson'), lines.join('\n') + '\n')
  return tracks.map((t) => t.id)
}

function defineTests () {
  test('the page against two sources of 20,000 tracks: restarts, a compaction, a power cut, a claim, and an app of before the deltas; at every checkpoint the page equals one started from nothing', { timeout: 900000 }, async (t) => {
    const { request, json, makeWav, fakeJpeg, makeProfile, proofHeaders, deviceKey } = await import('./helpers.mjs')
    const { keyOf } = await import('../server/lyrics.mjs')
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mpfy-e2e-scale-'))
    const kids = new Set()
    t.after(async () => {
      for (const k of kids) k.proc.kill('SIGKILL')
      await Promise.all([...kids].map((k) => k.exited))
      fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    })
    const dirs = { [A]: path.join(work, 'uno'), [B]: path.join(work, 'due') }
    const names = { [A]: 'Uno', [B]: 'Due' }
    const ids = {}
    ;[ids[A], ids[B]] = await Promise.all([makeSource(dirs[A], 'uno', { keyOf }), makeSource(dirs[B], 'due', { keyOf })])
    assert.deepEqual(ids[A].slice(0, SHARED), ids[B].slice(0, SHARED))

    // The sources.
    const src = {}
    const startSource = async (s) => {
      const k = child(['--source', dirs[s], names[s]], 'source ' + names[s])
      kids.add(k)
      k.exited.then(() => kids.delete(k))
      const r = await k.ready
      src[s] = { ...k, http: r.http, admin: r.admin, key: r.key }
      await k.call('quiet')
    }
    await Promise.all([startSource(A), startSource(B)])
    const portsNow = () => ({ [A]: src[A].http, [B]: src[B].http })

    // The page (it reads deltas) and the old app (it reads none).
    const page = child(['--page', JSON.stringify({ ports: portsNow() })], 'page')
    kids.add(page)
    await page.ready
    const call = (fn, ...args) => page.call('call', { fn, args })
    const old = { state: new Map(), noDelta: { [A]: 0, [B]: 0 } }
    const local = (s, method, p, opts = {}) => request(src[s].http, method, p, opts)
    const oldGet = async (s, p, opts) => {
      old.noDelta[s]++
      return local(s, 'GET', p, opts)
    }
    /** The old app asks as it always did: with `have` and the ETag it holds, never `delta`. */
    const oldFetch = async (s) => {
      const held = old.state.get(s)
      const r = await oldGet(s, '/api/library' + (held ? '?have=' + held.version : ''), { headers: held ? { 'if-none-match': held.etag } : {} })
      if (r.status === 304) return
      assert.equal(r.status, 200)
      const body = json(r)
      assert.ok(!('delta' in body) && !('epochs' in body), 'an answer without delta for the old app')
      if (body.tracks === null) {
        body.tracks = held.data.tracks
        body.covers = { track: held.data.covers.track, album: held.data.covers.album, playlist: body.covers.playlist }
      }
      old.state.set(s, { version: body.version, etag: r.headers.etag, data: body })
    }

    let checkpoints = 0
    const report = []
    /** The page equals a page started from nothing, and the old app a whole answer. */
    const checkpoint = async (what) => {
      checkpoints++
      await Promise.all([src[A].call('quiet'), src[B].call('quiet')])
      const live = path.join(work, 'live-' + checkpoints + '.json')
      const fresh = path.join(work, 'fresh-' + checkpoints + '.json')
      const lv = await page.call('dump', { file: live })
      const f = child(['--page', JSON.stringify({ ports: portsNow() })], 'fresh page')
      kids.add(f)
      const fr = await f.ready
      await f.call('dump', { file: fresh })
      f.proc.kill()
      await f.exited
      kids.delete(f)
      sameDump(JSON.parse(fs.readFileSync(live, 'utf8')), JSON.parse(fs.readFileSync(fresh, 'utf8')), what)
      fs.rmSync(live)
      fs.rmSync(fresh)
      for (const s of [A, B]) {
        await oldFetch(s)
        const whole = json(await oldGet(s, '/api/library'))
        assert.deepEqual(old.state.get(s).data, whole, what + ': the old app on ' + names[s] + ' holds a whole answer')
      }
      report.push(what + ': ' + lv.songs + ' songs; a page from nothing started in ' + fr.startMs + ' ms')
      t.diagnostic(report[report.length - 1])
    }
    /** The page's library answers since the last call, by source. */
    const answers = async () => {
      const list = await page.call('answers')
      const by = { [A]: list.filter((x) => x.src === A && x.status === 200), [B]: list.filter((x) => x.src === B && x.status === 200) }
      for (const x of list) assert.match(x.query, /delta=1/, 'the page always says it reads deltas')
      return by
    }

    /**
     * Every answer a delta: of the shared part always, of the user part whenever the page held a
     * user version (a person with no log yet holds the zero epoch: its first log is one whole
     * user part). `userHeld`: at least one answer was to a request that held one.
     */
    const deltas = (list, what, { userHeld = true } = {}) => {
      const ok = list.length > 0 && list.every((x) => (x.shared === true || x.same) && (x.user === true || !/[?&]uv=/.test(x.query))) &&
        (!userHeld || list.some((x) => /[?&]uv=/.test(x.query) && x.user === true))
      assert.ok(ok, what + ': deltas ' + JSON.stringify(list))
    }

    await Promise.all([oldFetch(A), oldFetch(B)])
    await checkpoint('start (both sources migrated from db.json)')
    await answers()

    // ---- both devices change things
    const a = ids[A]
    const b = ids[B]
    await call('like', a[10])
    await call('like', a[SHARED + 10])
    await call('like', a[11])
    const pl = await call('createPlaylist', 'Viaggio', '', [a[20], a[21], a[SHARED + 22]])
    await call('addToPlaylist', pl.id, [a[23], a[20]])
    await call('removeFromPlaylist', pl.id, [{ index: 0, id: a[20] }])
    await page.call('reverse', { id: pl.id, name: 'Viaggio lungo' })
    await call('editTrack', a[30], { title: 'Titolo dalla pagina' })
    await call('editTrack', a[SHARED + 30], { title: 'Solo su Uno' })
    await page.call('played', { trackId: a[40], context: { type: 'library' } })
    let r = await local(A, 'PUT', '/api/likes/' + a[50])
    assert.equal(r.status, 200)
    assert.equal(json(r).likes[0].id, a[50], 'without brief the old app gets the whole list, newest first')
    assert.ok(json(r).likes.length >= 4)
    assert.equal((await local(A, 'POST', '/api/playlists', { body: { name: 'Dal vecchio telefono' } })).status, 200)
    assert.equal((await local(A, 'POST', '/api/played', { body: { trackId: a[60] } })).status, 200)
    assert.equal((await local(A, 'PATCH', '/api/tracks/' + a[70], { body: { title: 'Dal vecchio telefono' } })).status, 200)
    assert.equal((await local(A, 'PUT', '/api/cover-for/track/' + a[80] + '?size=small', { body: fakeJpeg(81, 2000) })).status, 200)
    const up = json(await local(B, 'PUT', '/api/upload/nuovo.wav', { body: makeWav({ freq: 333, seconds: 1 }) }))
    assert.ok(up.track && up.track.id)
    assert.equal((await local(B, 'DELETE', '/api/tracks/' + b[SHARED + 90])).status, 200)
    assert.equal((await local(B, 'DELETE', '/api/tracks/' + b[90])).status, 200, 'a file both sources hold, gone from one')
    assert.equal((await local(B, 'PUT', '/api/likes/' + b[91])).status, 200)
    await page.call('settle')
    let got = await answers()
    deltas(got[A], 'Uno', { userHeld: false })
    deltas(got[B], 'Due', { userHeld: false })
    assert.ok(got[A].every((x) => x.bytes < 200000) && got[B].every((x) => x.bytes < 200000), 'small answers')
    await checkpoint('both devices changed things on both sources')
    await answers()

    // ---- Uno restarted: its log is its change index, nothing forces a whole part
    await src[A].call('close')
    await src[A].exited
    await startSource(A)
    await page.call('ports', { ports: portsNow() })
    await local(A, 'PUT', '/api/likes/' + a[100])
    await call('like', a[101])
    await call('unlike', a[11])
    await page.call('settle')
    got = await answers()
    deltas(got[A], 'Uno after a restart')
    await checkpoint('Uno restarted')
    await answers()

    // ---- Due compacted: lines keep their versions, nothing forces a whole part
    await local(B, 'PUT', '/api/likes/' + b[120])
    await local(B, 'POST', '/api/playlists', { body: { name: 'Sulla seconda' } })
    await page.call('settle')
    await answers()
    const comp = await src[B].call('compact')
    assert.match(comp.head[1], /^\{"ep":\[\[/, 'the library log of Due was compacted: ' + JSON.stringify(comp.head))
    assert.ok(Object.keys(comp.after).some((f) => f.startsWith('users/')), 'and the person log of its owner')
    await local(B, 'PATCH', '/api/tracks/' + b[SHARED + 130], { body: { title: 'Dopo la compattazione' } })
    await local(B, 'PUT', '/api/likes/' + b[131])
    await local(B, 'DELETE', '/api/likes/' + b[120])
    await page.call('settle')
    got = await answers()
    deltas(got[B], 'Due after a compaction')
    await checkpoint('Due compacted (' + JSON.stringify(comp.before) + ' -> ' + JSON.stringify(comp.after) + ')')
    await answers()

    // ---- a power cut on Uno: what the page saw after the last bytes on disk is lost
    const disk = (await src[A].call('synced')).logs
    await call('like', a[140])
    const pl2 = await call('createPlaylist', 'Persa', '', [a[141]])
    assert.ok(pl2 && pl2.id)
    await call('editTrack', a[142], { title: 'Perso nel buio' })
    await local(A, 'PUT', '/api/likes/' + a[143])
    await page.call('settle')
    await answers()
    src[A].proc.kill('SIGKILL')
    await src[A].exited
    for (const f of fs.readdirSync(path.join(dirs[A], 'users'))) {
      if (f.endsWith('.log') && disk['users/' + f] === undefined) fs.rmSync(path.join(dirs[A], 'users', f))
    }
    for (const [f, size] of Object.entries(disk)) {
      const file = path.join(dirs[A], f)
      if (size !== null && fileSize(file) > size) fs.truncateSync(file, size)
    }
    await startSource(A)
    await page.call('ports', { ports: portsNow() })
    await page.call('settle')
    got = await answers()
    assert.ok(got[A].length && got[A].some((x) => x.shared === false && !x.same) && got[A].some((x) => x.user === false), 'versions lost in a power cut: whole parts ' + JSON.stringify(got[A]))
    await checkpoint('a power cut on Uno')
    await answers()
    await call('like', a[150])
    await page.call('settle')
    got = await answers()
    deltas(got[A], 'Uno after the power cut')
    await checkpoint('a change after the power cut')
    await answers()

    // ---- Due claimed by a new profile: the owner's data merged into it
    assert.equal((await local(B, 'POST', '/api/admin/claim', { body: { minutes: 30 } })).status, 200)
    const profile = makeProfile()
    const key = deviceKey()
    await src[B].call('admit', { key })
    const asNew = (method, p, opts = {}) => request(src[B].http, method, p, { ...opts, headers: { 'x-test-client': key, ...proofHeaders(profile, key, src[B].key), ...(opts.headers || {}) }, localAddress: '127.0.0.2' })
    assert.equal(json(await asNew('GET', '/api/profile')).role, 'owner', 'the claim')
    assert.equal((await asNew('PUT', '/api/likes/' + b[160] + '?brief=1')).status, 200)
    await page.call('settle')
    got = await answers()
    assert.ok(got[B].length && got[B].some((x) => x.user === false), 'a person merged into: one whole user part ' + JSON.stringify(got[B]))
    await checkpoint('Due claimed by a new profile')
    await answers()
    await asNew('PUT', '/api/likes/' + b[161] + '?brief=1')
    await local(B, 'POST', '/api/played', { body: { trackId: b[162] } })
    await page.call('settle')
    got = await answers()
    deltas(got[B], 'Due after the claim')
    await checkpoint('changes after the claim')

    // ---- a page started from the first page's IndexedDB: the same, with nothing asked again whole
    const idbFile = path.join(work, 'idb.bin')
    const saved = await page.call('saveIdb', { file: idbFile })
    const again = child(['--page', JSON.stringify({ ports: portsNow(), idbFile })], 'page from its cache')
    kids.add(again)
    await again.ready
    const fromCache = await again.call('answers')
    assert.ok(fromCache.length >= 2 && fromCache.every((x) => x.status === 304), 'a start from the cache: only 304s ' + JSON.stringify(fromCache) + ' ' + JSON.stringify(saved) + again.log().slice(-3000))
    const cached = path.join(work, 'cached.json')
    await again.call('dump', { file: cached })
    const live = path.join(work, 'live-end.json')
    await page.call('dump', { file: live })
    sameDump(JSON.parse(fs.readFileSync(cached, 'utf8')), JSON.parse(fs.readFileSync(live, 'utf8')), 'a page started from the IndexedDB of the first')

    // The library requests without delta: the old app's, counted by the source that never stopped.
    const health = json(await request(src[B].admin, 'GET', '/admin/health'))
    assert.equal(health.legacyLibrary.count, old.noDelta[B], 'the old app\'s library requests counted, the page\'s not')
    assert.ok(checkpoints >= 8)
  })
}

/** Two dumps of the store are the same; the first difference is named by its path. */
function sameDump (a, b, what) {
  const where = firstDiff(a, b, '')
  if (where !== null) assert.fail(what + ': the page and the page from nothing differ at ' + where.path + ':\n' + String(JSON.stringify(where.x)).slice(0, 1500) + '\n' + String(JSON.stringify(where.y)).slice(0, 1500))
}

function firstDiff (x, y, at) {
  if (JSON.stringify(x) === JSON.stringify(y)) return null
  if (x && y && typeof x === 'object' && typeof y === 'object') {
    if (Array.isArray(x) !== Array.isArray(y)) return { path: at, x, y }
    const keys = Array.isArray(x) ? Array.from({ length: Math.max(x.length, y.length) }, (_, i) => i) : [...new Set([...Object.keys(x), ...Object.keys(y)])]
    for (const k of keys) {
      const d = firstDiff(x[k], y[k], at + '/' + k)
      if (d !== null) return d
    }
  }
  return { path: at, x, y }
}
