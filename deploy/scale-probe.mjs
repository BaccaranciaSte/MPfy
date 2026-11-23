// The scale probe: a whole source at the size its heap is planned for, measured on the machine it
// runs on (made for the Mi A2, run on a PC too for the ratio between the two). It works in a
// folder of its own, as a process of its own: nothing of a source already installed is read or
// changed, and its folder can be deleted after.
//
//   node deploy/scale-probe.mjs build <dir> [--tracks 50100] [--people 6] [--stores heavy|light] [--per 300000]
//       a source of before the logs (db.json, its files, every tag and lyric already read), its
//       library log made by one start, the chat and the comments, and the people: --people at
//       300,000 likes and 300,000 playlist entries (--per), plus three more of the same size (one to
//       open on first use, one opened while a whole answer streams, one merged into another)
//   node --max-old-space-size=160 --expose-gc deploy/scale-probe.mjs run <dir> [--p2p] [--alone]
//       the measured process: the source started on <dir> (P2P on the real DHT with --p2p), the
//       people loaded, the live heap against the plan, one person's costs, then the worst
//       moments together (a slow client reading a whole answer, a person opened, a merge of two
//       people at the caps and the library's compaction at once), then a track removed from
//       every loaded person; with --alone each of those moments one after the other instead
//   node --max-old-space-size=160 --expose-gc deploy/scale-probe.mjs size <dir> [--p2p]
//       the source built on <dir> started, nobody loaded: its live heap (two sizes give the cost
//       of one more track)
//   node --max-old-space-size=160 --expose-gc deploy/scale-probe.mjs base <dir> [--p2p]
//       an empty source: its heap, and with --p2p its DHT node after a minute on the network
//   node deploy/scale-probe.mjs cpu
//       the same fixed work timed, for the ratio between two machines
//
// Every measure is one JSON line on stdout. A guard reads /proc/meminfo and the thermal zones
// every 2 s: with less than 600 MB available or a zone over 75 C the probe stops at once (exit 3).
// The caps are taken as they would be raised (300,000) in the measured process only.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import http from 'node:http'
import zlib from 'node:zlib'
import { monitorEventLoopDelay, PerformanceObserver, constants } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const server = (p) => import(pathToFileURL(path.join(ROOT, 'server', p)).href)
const [mode, dirArg] = process.argv.slice(2)
const flag = (name, d) => {
  const i = process.argv.indexOf('--' + name)
  return i > 0 ? process.argv[i + 1] : d
}
const has = (name) => process.argv.includes('--' + name)
const MB = 1048576
const r1 = (x) => Math.round(x * 10) / 10
const say = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const CAP = 300000
const MIN_AVAILABLE_KB = 600 * 1024
const MAX_CELSIUS = 75

// ---------------------------------------------------------------------------------------- guard

function memAvailableKb () {
  try {
    const m = /MemAvailable:\s+(\d+)/.exec(fs.readFileSync('/proc/meminfo', 'utf8'))
    return m ? Number(m[1]) : null
  } catch {
    return null
  }
}

// The hottest thermal zone in degrees: zones give C, tenths or thousandths.
function hottest () {
  let max = null
  let names = []
  try {
    names = fs.readdirSync('/sys/class/thermal').filter((n) => n.startsWith('thermal_zone'))
  } catch {
    return null
  }
  for (const n of names) {
    try {
      let v = Number(fs.readFileSync('/sys/class/thermal/' + n + '/temp', 'utf8').trim())
      if (!Number.isFinite(v) || v <= 0) continue
      if (v > 1000) v /= 1000
      else if (v > 200) v /= 10
      if (max === null || v > max) max = v
    } catch {}
  }
  return max
}

function guard () {
  const check = () => {
    const kb = memAvailableKb()
    const c = hottest()
    if ((kb !== null && kb < MIN_AVAILABLE_KB) || (c !== null && c > MAX_CELSIUS)) {
      say({ stopped: true, memAvailableMB: kb === null ? null : r1(kb / 1024), celsius: c })
      process.exit(3)
    }
    return { memAvailableMB: kb === null ? null : r1(kb / 1024), celsius: c }
  }
  const timer = setInterval(check, 2000)
  timer.unref()
  return check
}

// ------------------------------------------------------------------------------------ measures

function live () {
  for (let i = 0; i < 3; i++) globalThis.gc()
  const m = process.memoryUsage()
  return { heapMB: r1(m.heapUsed / MB), externalMB: r1(m.external / MB), arrayBuffersMB: r1(m.arrayBuffers / MB), rssMB: r1(m.rss / MB) }
}

/** Major GCs, the longest event loop delay and the heap seen right after each major GC. */
function watch () {
  const loop = monitorEventLoopDelay({ resolution: 5 })
  loop.enable()
  const cpu0 = process.cpuUsage()
  const w = { majors: 0, majorMs: 0, afterMajorMaxMB: 0, peakHeapMB: 0, peakRssMB: 0 }
  const obs = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if ((e.detail?.kind ?? e.kind) !== constants.NODE_PERFORMANCE_GC_MAJOR) continue
      w.majors++
      w.majorMs += e.duration
      w.afterMajorMaxMB = Math.max(w.afterMajorMaxMB, process.memoryUsage().heapUsed / MB)
    }
  })
  obs.observe({ entryTypes: ['gc'] })
  const sample = setInterval(() => {
    const m = process.memoryUsage()
    w.peakHeapMB = Math.max(w.peakHeapMB, m.heapUsed / MB)
    w.peakRssMB = Math.max(w.peakRssMB, m.rss / MB)
  }, 10)
  return () => {
    clearInterval(sample)
    obs.disconnect()
    loop.disable()
    const c = process.cpuUsage(cpu0)
    return { cpuMs: Math.round((c.user + c.system) / 1000), majorGCs: w.majors, majorGCms: Math.round(w.majorMs), heapAfterMajorMaxMB: r1(w.afterMajorMaxMB), peakHeapMB: r1(w.peakHeapMB), peakRssMB: r1(w.peakRssMB), longestTurnMs: r1(loop.max / 1e6), turnP99Ms: r1(loop.percentile(99) / 1e6) }
  }
}

/** GET on the API port; reads at `rate` bytes per second (null: as fast as it comes). */
function get (port, p, { rate = null, gzip = false } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now()
    const req = http.get({ host: '127.0.0.1', port, path: p, agent: false, headers: gzip ? { 'accept-encoding': 'gzip' } : {} }, (res) => {
      let bytes = 0
      let first = null
      const t1 = performance.now()
      res.on('data', (c) => {
        if (first === null) first = performance.now() - t0
        bytes += c.length
        if (rate !== null) {
          res.pause()
          setTimeout(() => res.resume(), (c.length / rate) * 1000)
        }
      })
      res.on('end', () => resolve({ status: res.statusCode, bytes, firstByteMs: Math.round(first ?? t1 - t0), ms: Math.round(performance.now() - t0) }))
      res.on('error', reject)
    })
    req.on('error', reject)
  })
}

function send (port, method, p, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body)
    const req = http.request({ host: '127.0.0.1', port, method, path: p, agent: false, headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {} }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end(payload)
  })
}

const tick = () => new Promise((resolve) => setImmediate(resolve))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const hex = (bytes, seed) => crypto.createHash('sha256').update(seed).digest('hex').slice(0, bytes * 2)

// ------------------------------------------------------------------------------------- build

async function build (dir) {
  const N = Number(flag('tracks', 50100))
  const P = Number(flag('people', 6))
  const stores = flag('stores', 'heavy')
  const PER = Number(flag('per', CAP))
  const MSG = stores === 'heavy' ? 5000 : 500
  const COMMENTS = stores === 'heavy' ? 20000 : 2000
  const check = guard()
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error(dir + ' is not empty')
  fs.mkdirSync(path.join(dir, 'library'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'lyrics'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'fingerprints'), { recursive: true })
  const t0 = performance.now()
  // Each track's whole fingerprint as fpcalc leaves it (970 items), so its signature stays.
  const fpItems = crypto.randomBytes(970 * 4)
  const fpHead = Buffer.alloc(16)
  fpHead.write('MPFP', 0, 'latin1')
  fpHead.writeUInt32LE(1, 4)

  // The tracks: every stored field (a details lookup record too), a signature, a file each;
  // titles of a few words, an artist for every 12 tracks, three albums per artist.
  const { keyOf } = await server('lyrics.mjs')
  let seed = 12345
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  const WORDS = 'amore notte sole mare cielo vento fuoco luna stella cuore tempo vita sogno strada casa citta fiume pioggia neve estate inverno ombra luce voce mondo canzone ballo festa'.split(' ')
  const word = () => WORDS[Math.floor(rnd() * WORDS.length)]
  const artists = Math.max(1, Math.floor(N / 12))
  const uuid = (k) => {
    const x = hex(16, k)
    return x.slice(0, 8) + '-' + x.slice(8, 12) + '-' + x.slice(12, 16) + '-' + x.slice(16, 20) + '-' + x.slice(20, 32)
  }
  const ids = []
  const db = fs.openSync(path.join(dir, 'db.json'), 'w')
  fs.writeSync(db, '{"schema":3,"version":7,"covers":{"track":{},"album":{}},"gone":[],"tracks":[')
  const lyr = fs.openSync(path.join(dir, 'lyrics', 'index.ndjson'), 'w')
  fs.writeSync(lyr, '{"schema":1}\n')
  let dbBuf = []
  let lyrBuf = []
  for (let i = 0; i < N; i++) {
    const body = Buffer.from('MPfy, file di prova ' + i + ' ' + '.'.repeat(i % 40))
    const id = crypto.createHash('sha256').update(body).digest('hex').slice(0, 24)
    ids.push(id)
    fs.writeFileSync(path.join(dir, 'library', id + '.mp3'), body)
    const a = Math.floor(rnd() * artists)
    const artist = 'Artista ' + word() + ' ' + a
    const words = Array.from({ length: 1 + Math.floor(rnd() * 4) }, word).join(' ')
    const d = Math.round((120 + rnd() * 300) * 10) / 10
    const t = {
      id, fileHash: id, format: 'mp3', size: body.length, title: words.replace(/^./, (c) => c.toUpperCase()) + (i % 7 === 0 ? ' (Remastered 2011)' : ''),
      artist, album: 'Album ' + word() + ' ' + Math.floor(a * 3 + rnd() * 3), albumArtist: artist,
      trackNo: 1 + Math.floor(rnd() * 14), discNo: 1, year: 1960 + Math.floor(rnd() * 64), duration: d, bitrate: 320000, sampleRate: 44100, codec: 'mp3', cutoffHz: 19500, tagless: [],
      fp: { d, b: 32, s: Buffer.concat([0, 1, 2, 3].map((k) => crypto.createHash('sha512').update('a' + i + ':' + k).digest())).toString('base64') }, fpState: 'ok',
      qualityV: 0, addedAt: 1700000000000 + i * 1000, uploaders: ['owner'], notSame: [], edited: [],
      lookup: { v: 1, state: 'applied', at: 1700000000000, tries: 1, fileHash: id, acoustid: uuid('acoustid ' + i), recording: uuid('recording ' + i), release: uuid('release ' + i), filled: ['year'] }
    }
    fpHead.writeDoubleLE(d, 8)
    fs.writeFileSync(path.join(dir, 'fingerprints', id + '.fp'), Buffer.concat([fpHead, fpItems]))
    dbBuf.push(JSON.stringify(t))
    lyrBuf.push(JSON.stringify([id, { kind: null, from: null, key: keyOf(t), lookup: null }]))
    if (dbBuf.length === 1000) {
      fs.writeSync(db, (i >= 1000 ? ',' : '') + dbBuf.join(','))
      fs.writeSync(lyr, lyrBuf.join('\n') + '\n')
      dbBuf = []
      lyrBuf = []
      check()
    }
  }
  if (dbBuf.length) fs.writeSync(db, (N > dbBuf.length ? ',' : '') + dbBuf.join(','))
  if (lyrBuf.length) fs.writeSync(lyr, lyrBuf.join('\n') + '\n')
  fs.writeSync(db, ']}')
  fs.closeSync(db)
  fs.closeSync(lyr)
  say({ built: 'tracks', tracks: N, s: Math.round((performance.now() - t0) / 1000) })

  // One start makes the library log (and the source's identity, which names the group chat).
  const { createMPfy } = await server('app.mjs')
  let app = await createMPfy({ dataDir: dir, port: 0, adminPort: 0, p2p: false, ffmpeg: null, fpcalc: null, sevenZip: null, name: 'Sonda' })
  await app.jobs.idle()
  await app.lyrics.idle()
  const serverKey = app.serverPublicKey
  await app.close()
  app = null
  say({ built: 'library.log', bytes: fs.statSync(path.join(dir, 'library.log')).size, s: Math.round((performance.now() - t0) / 1000) })

  // The chat: six people, the group and the 15 direct chats, MSG messages each.
  const { directIdOf, groupIdOf } = await server('chat.mjs')
  const people = Array.from({ length: 6 }, (_, i) => hex(16, 'person ' + i)).sort()
  const box = crypto.randomBytes(141).toString('base64')
  fs.mkdirSync(path.join(dir, 'chat'), { recursive: true })
  const conversation = (cid, header, to) => {
    const fd = fs.openSync(path.join(dir, 'chat', cid + '.ndjson'), 'w')
    fs.writeSync(fd, JSON.stringify({ h: header }) + '\n')
    let buf = []
    for (let s = 1; s <= MSG; s++) {
      const boxes = {}
      for (const p of to) boxes[p] = box
      buf.push(JSON.stringify({ m: { id: hex(16, cid + ':' + s), seq: s, from: to[s % to.length], at: Date.now() - (MSG - s) * 60000, boxes } }))
      if (buf.length === 500) {
        fs.writeSync(fd, buf.join('\n') + '\n')
        buf = []
      }
    }
    if (buf.length) fs.writeSync(fd, buf.join('\n') + '\n')
    fs.closeSync(fd)
  }
  conversation(groupIdOf(serverKey), { v: 1, kind: 'group' }, people)
  for (let i = 0; i < 6; i++) for (let j = i + 1; j < 6; j++) conversation(directIdOf(people[i], people[j]), { v: 1, kind: 'direct', a: people[i], b: people[j] }, [people[i], people[j]])

  // The comments: COMMENTS over a quarter as many tracks, and the files of the 256 tracks the
  // run reads (its cache), 20 comments each (one per person per track: 20 authors).
  fs.mkdirSync(path.join(dir, 'comments'), { recursive: true })
  const lines = ['{"schema":1}']
  for (let i = 0; i < COMMENTS; i++) lines.push(JSON.stringify([hex(16, 'comment ' + i), [ids[i % Math.max(1, COMMENTS / 4)], people[i % 6]]]))
  for (let t = 0; t < 256; t++) {
    const list = Array.from({ length: 20 }, (_, k) => ({ id: hex(16, 'read ' + t + ':' + k), from: hex(16, 'author ' + k), at: Date.now() - (t * 20 + k) * 1000, text: ('commento ' + t + ' ').repeat(12).slice(0, 120) }))
    for (const c of list) lines.push(JSON.stringify([c.id, [ids[N - 1 - t], c.from]]))
    fs.writeFileSync(path.join(dir, 'comments', ids[N - 1 - t] + '.json'), JSON.stringify({ schema: 1, comments: list }))
  }
  fs.writeFileSync(path.join(dir, 'comments', 'index.ndjson'), lines.join('\n') + '\n')
  say({ built: 'stores', stores, chatMessages: MSG * 16, comments: COMMENTS + 256 * 20, s: Math.round((performance.now() - t0) / 1000) })

  // The people at the caps: 300,000 likes (the library's ids, then others) and 300,000 entries in
  // playlists of 2,000. The first is the owner (the run reads it over HTTP from 127.0.0.1).
  const { Users } = await server('users.mjs')
  const keys = ['owner', ...Array.from({ length: P - 1 + 3 }, (_, i) => hex(16, 'profile ' + i))]
  const users = new Users({ dataDir: dir, caps: { likes: Math.max(CAP, PER), entries: Math.max(CAP, PER) } })
  users.load()
  for (const [k, key] of keys.entries()) {
    const u = users.get(key)
    const idOf = (i) => (i < N ? ids[(i + k * 997) % N] : hex(12, key + ':' + i))
    for (let at = 0; at < PER; at += 5000) {
      u.bulkLikes({ add: Array.from({ length: Math.min(5000, PER - at) }, (_, j) => idOf(at + j)) })
      if (at % 50000 === 0) await tick()
    }
    for (let n = 0; n < PER / 2000; n++) {
      const p = u.createPlaylist({ name: 'Playlist ' + n })
      u.addToPlaylist(p.id, Array.from({ length: 2000 }, (_, j) => idOf((n * 2000 + j * 7919) % (PER * 2))))
      if (n % 10 === 0) await tick()
    }
    for (let i = 0; i < 1000; i++) u.played(ids[(i * 31) % N], { type: 'library' }, Date.now() - (1000 - i) * 60000)
    await u.log.compact()
    check()
    say({ built: 'person', key: key === 'owner' ? key : key.slice(0, 8), bytes: fs.statSync(users.fileOf(key)).size, s: Math.round((performance.now() - t0) / 1000) })
  }
  await users.settled()
  users.close()
  fs.writeFileSync(path.join(dir, 'probe.json'), JSON.stringify({ tracks: N, people: P, stores, per: PER, keys, removable: ids[0] }))
  say({ built: 'done', s: Math.round((performance.now() - t0) / 1000) })
}

// --------------------------------------------------------------------------------------- run

async function run (dir) {
  const check = guard()
  const plan = JSON.parse(fs.readFileSync(path.join(dir, 'probe.json'), 'utf8'))
  const p2p = has('p2p')
  const before = live()
  say({ step: 'imports', ...before, ...check() })
  const { createMPfy } = await server('app.mjs')
  const t0 = performance.now()
  const app = await createMPfy({ dataDir: dir, port: 0, adminPort: 0, p2p, ffmpeg: null, fpcalc: null, sevenZip: null, name: 'Sonda' })
  const startedMs = Math.round(performance.now() - t0)
  await app.jobs.idle()
  await app.lyrics.idle()
  if (p2p) await app.transportReady
  // The caps as they would be raised (300,000), in this process only.
  app.users.maxLikes = CAP
  app.users.maxEntries = CAP
  const port = app.ports.http
  const health = async () => JSON.parse((await send(app.ports.admin, 'GET', '/admin/health')).body)
  // The comments cache: the 256 tracks read once.
  for (const t of fs.readdirSync(path.join(dir, 'comments'))) if (/^[0-9a-f]{24}\.json$/.test(t)) app.comments.list([t.slice(0, 24)], null, () => false)
  const started = live()
  say({ step: 'started', startedMs, tracks: app.library.tracks.size, p2p, ...started, ...check() })

  // The people at the caps, loaded and held.
  const keys = plan.keys
  const held = []
  for (const key of keys.slice(0, plan.people)) held.push(await app.users.open(key))
  const loaded = live()
  const fixed = plan.stores === 'heavy' ? 48.4 : 20.7
  const eSum = r1(fixed + 3.0 * (plan.per / CAP) * plan.people + plan.tracks * 1122 / MB)
  say({ step: 'people loaded', people: plan.people, ...loaded, eSumMB: eSum, againstE: r1((loaded.heapMB / eSum - 1) * 100) + '%', perPersonMB: r1((loaded.heapMB - started.heapMB) / plan.people), perPersonExternalMB: r1((loaded.externalMB - started.externalMB) / plan.people), ...check() })
  if (p2p) say({ step: 'dht', ...((await health()).transport || {}) })

  // One person at the caps (the owner): a change, the first sync, deltas, a compaction.
  const owner = held[0].user
  // Ids the owner likes, known from how they were made (reading the likes would build them all).
  const liked = Array.from({ length: Math.min(10000, plan.per - plan.tracks) }, (_, i) => hex(12, 'owner:' + (plan.per - Math.min(10000, plan.per - plan.tracks) + i)))
  const someLiked = liked.slice(0, 200)
  let w = watch()
  let ms = performance.now()
  for (const id of someLiked) owner.unlike(id)
  for (const id of someLiked) owner.like(id)
  say({ step: 'one change', changeMs: Math.round((performance.now() - ms) / (someLiked.length * 2) * 1000) / 1000, changes: someLiked.length * 2, ...w() })
  let r = await send(port, 'PUT', '/api/likes/' + someLiked[0] + '?brief=1')
  ms = performance.now()
  r = await send(port, 'PUT', '/api/likes/' + someLiked[1] + '?brief=1')
  say({ step: 'a like over HTTP', status: r.status, ms: r1(performance.now() - ms), bytes: r.body.length })
  const shared = `have=${app.library.version}&he=${app.library.epoch}`
  for (const gzip of [false, true]) {
    const w = watch()
    const a = await get(port, '/api/library?delta=1&' + shared, { gzip })
    say({ step: 'first sync of the person (user part whole)', gzip, ...a, MB: r1(a.bytes / MB), ...w() })
  }
  const uv0 = owner.version
  const ue0 = owner.epoch
  for (let i = 0; i < 50; i++) {
    owner.unlike(someLiked[i])
    owner.like(someLiked[i])
  }
  w = watch()
  let a = await get(port, `/api/library?delta=1&${shared}&uv=${uv0}&ue=${ue0}`)
  say({ step: 'a delta of 100 changes', ...a, ...w() })
  const uv1 = owner.version
  for (let k = 0; k < 4; k++) {
    const chunk = liked.slice(k * 2500, k * 2500 + 2500)
    if (chunk.length) owner.bulkLikes({ remove: chunk, add: chunk })
  }
  w = watch()
  a = await get(port, `/api/library?delta=1&${shared}&uv=${uv1}&ue=${ue0}`)
  say({ step: 'a delta of 10,000 changes', ...a, ...w() })
  w = watch()
  ms = performance.now()
  await owner.log.compact()
  say({ step: 'compaction of the person', ms: Math.round(performance.now() - ms), bytes: fs.statSync(app.users.fileOf('owner')).size, ...w() })

  // Open on first use: a person at the caps not loaded.
  const opened = keys[plan.people]
  w = watch()
  ms = performance.now()
  const o = await app.users.open(opened)
  say({ step: 'open on first use', ms: Math.round(performance.now() - ms), ...w(), ...live() })
  o.release()

  // The worst moments together: a slow client reads the owner's whole answer, a person is opened
  // meanwhile, two people at the caps are merged and the library is compacted, with small changes
  // every 100 ms. With --alone, each of them on its own first.
  const inMiddle = keys[plan.people + 1]
  const mergeFrom = keys[plan.people + 2]
  const mergeTo = keys[plan.people - 1]
  if (has('alone')) {
    const alone = async (what, fn) => {
      const wa = watch()
      const ta = performance.now()
      const out = await fn()
      say({ step: 'alone: ' + what, ms: Math.round(performance.now() - ta), ...(out || {}), ...wa(), ...check() })
    }
    await alone('a whole answer read at full speed', async () => {
      const x = await get(port, '/api/library?delta=1')
      return { MB: r1(x.bytes / MB) }
    })
    await alone('a person opened', async () => {
      const x = await app.users.open(inMiddle)
      x.release()
    })
    await alone('a merge of two people at the caps', async () => ({ ok: await app.users.merge(mergeFrom, mergeTo) }))
    await alone('the library compacted', () => app.library.compact())
    await app.users.settled()
    say({ step: 'after', ...live() })
    for (const h of held) h.release()
    await app.close()
    say({ step: 'closed', ...check() })
    return
  }
  w = watch()
  const t1 = performance.now()
  const stream = get(port, '/api/library?delta=1', { rate: 1024 * 1024 }).then((x) => ({ ...x, endMs: Math.round(performance.now() - t1) }))
  await sleep(500)
  const opening = app.users.open(inMiddle).then((x) => ({ x, endMs: Math.round(performance.now() - t1) }))
  const merging = app.users.merge(mergeFrom, mergeTo).then((ok) => ({ ok, endMs: Math.round(performance.now() - t1) }))
  const compacting = app.library.compact().then(() => ({ endMs: Math.round(performance.now() - t1) }))
  let changes = 0
  const churn = setInterval(() => {
    const id = someLiked[changes++ % someLiked.length]
    send(port, 'DELETE', '/api/likes/' + id + '?brief=1').then(() => send(port, 'PUT', '/api/likes/' + id + '?brief=1')).catch(() => {})
  }, 100)
  const [sr, op, mr, cr] = await Promise.all([stream, opening, merging, compacting])
  clearInterval(churn)
  op.x.release()
  say({ step: 'worst moments together', stream: { status: sr.status, MB: r1(sr.bytes / MB), endMs: sr.endMs }, openEndMs: op.endMs, merge: mr, compactionEndMs: cr.endMs, changes: changes * 2, ...w(), ...check() })
  say({ step: 'after', ...live() })

  // A track removed from every loaded person (the sweep's first slice runs inside the request).
  w = watch()
  ms = performance.now()
  r = await send(port, 'DELETE', '/api/tracks/' + plan.removable)
  say({ step: 'a track removed everywhere', status: r.status, ms: Math.round(performance.now() - ms), ...w() })
  await app.users.settled()

  for (const h of held) h.release()
  await app.close()
  say({ step: 'closed', ...check() })
}

// --------------------------------------------------------------------------------------- size

async function size (dir) {
  const check = guard()
  const plan = JSON.parse(fs.readFileSync(path.join(dir, 'probe.json'), 'utf8'))
  const { createMPfy } = await server('app.mjs')
  const app = await createMPfy({ dataDir: dir, port: 0, adminPort: 0, p2p: has('p2p'), ffmpeg: null, fpcalc: null, sevenZip: null, name: 'Sonda' })
  await app.jobs.idle()
  await app.lyrics.idle()
  for (const t of fs.readdirSync(path.join(dir, 'comments'))) if (/^[0-9a-f]{24}\.json$/.test(t)) app.comments.list([t.slice(0, 24)], null, () => false)
  say({ step: 'size', tracks: app.library.tracks.size, stores: plan.stores, ...live(), ...check() })
  await app.close()
}

// --------------------------------------------------------------------------------------- base

async function base (dir) {
  const check = guard()
  fs.mkdirSync(dir, { recursive: true })
  const p2p = has('p2p')
  const { createMPfy } = await server('app.mjs')
  const t0 = performance.now()
  const app = await createMPfy({ dataDir: dir, port: 0, adminPort: 0, p2p, ffmpeg: null, fpcalc: null, sevenZip: null, name: 'Sonda' })
  if (p2p) await app.transportReady
  say({ step: 'empty source', p2p, readyMs: Math.round(performance.now() - t0), ...live(), ...check() })
  if (p2p) {
    await sleep(60000)
    const h = JSON.parse((await send(app.ports.admin, 'GET', '/admin/health')).body)
    say({ step: 'empty source after a minute on the DHT', ...live(), transport: h.transport || null, ...check() })
  }
  await app.close()
}

// ---------------------------------------------------------------------------------------- cpu

function cpu () {
  const t0 = performance.now()
  let sink = 0
  const tracks = Array.from({ length: 20000 }, (_, i) => ({ id: hex(12, 'c' + i), title: 'Brano ' + i, artist: 'Artista ' + (i % 900), duration: i % 300, fp: { d: i, b: 32, s: 'x'.repeat(344) } }))
  for (let k = 0; k < 5; k++) sink += JSON.parse(JSON.stringify(tracks)).length
  const nums = Float64Array.from({ length: 1000000 }, (_, i) => Math.sin(i) * 1e6)
  nums.sort()
  sink += nums[0]
  const h = crypto.createHash('sha256')
  const block = Buffer.alloc(1 << 20, 7)
  for (let k = 0; k < 64; k++) h.update(block)
  sink += h.digest()[0]
  sink += zlib.gzipSync(Buffer.from(JSON.stringify(tracks))).length
  say({ step: 'cpu', ms: Math.round(performance.now() - t0), sink: sink !== 0 })
}

// ------------------------------------------------------------------------------------------ main

try {
  if (mode === 'build') await build(path.resolve(dirArg))
  else if (mode === 'run') await run(path.resolve(dirArg))
  else if (mode === 'base') await base(path.resolve(dirArg))
  else if (mode === 'size') await size(path.resolve(dirArg))
  else if (mode === 'cpu') cpu()
  else throw new Error('usage: scale-probe.mjs build|run|base <dir> | cpu')
  process.exit(0)
} catch (err) {
  say({ error: String((err && err.stack) || err) })
  process.exit(1)
}
