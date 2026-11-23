// The files of the format before logs (db.json, users/<key>.json): db.json is
// read in pieces, never whole, and a .json whose time changed but whose bytes
// did not (a copy that did not keep the times) never sends a newer log aside.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Library } from '../server/library.mjs'
import { Users } from '../server/users.mjs'
import { readDbJson } from '../server/dbjson.mjs'
import { tmpDir, cleanup, shardPath, rmDir } from './helpers.mjs'

const T = (n) => 'b' + n.toString(16).padStart(23, '0')

// A big db.json opened in a child process under a small heap (this file, run alone).
if (process.env.MPFY_DB_HEAP_DIR) {
  const lib = new Library({ dataDir: process.env.MPFY_DB_HEAP_DIR })
  const r = await lib.open()
  console.log(JSON.stringify({ status: r.status, dropped: r.dropped }))
  lib.close()
  process.exit(0)
}

function track (id, extra = {}) {
  return {
    id,
    title: 'Brano ' + id.slice(-4),
    artist: 'Riva Nord',
    album: 'Acque basse',
    albumArtist: 'Riva Nord',
    trackNo: 1,
    discNo: 1,
    year: 2020,
    duration: 200,
    format: 'mp3',
    mime: 'audio/mpeg',
    size: 16,
    bitrate: 320000,
    addedAt: 1700000000000,
    coverId: null,
    fileHash: id,
    uploaders: ['owner'],
    ...extra
  }
}

function putFile (dir, t) {
  const file = shardPath(dir, 'library', t.id + '.' + t.format)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, Buffer.alloc(t.size))
  return t
}

function lastLine (file) {
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
  return JSON.parse(lines[lines.length - 1])
}

const asideIn = (dir) => fs.readdirSync(dir).filter((n) => n.includes('.replaced-'))

// The same bytes written again with another time, as a copy without times leaves them.
function touch (file) {
  const bytes = fs.readFileSync(file)
  fs.writeFileSync(file, bytes)
  const later = new Date(Date.now() + 60000)
  fs.utimesSync(file, later, later)
}

test('db.json copied without its times: the log stays the truth, and knows the new stat', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  const a = putFile(dir, track(T(1), { title: 'Primo' }))
  const b = putFile(dir, track(T(2), { title: 'Secondo' }))
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ schema: 3, version: 7, tracks: [a, b], covers: { track: {}, album: {} } }))
  let lib = new Library({ dataDir: dir })
  await lib.open()
  lib.updateTrack(b.id, { title: 'Cambiato dopo' })
  lib.close()
  touch(path.join(dir, 'db.json'))
  lib = new Library({ dataDir: dir })
  await lib.open()
  assert.equal(lib.getTrack(b.id).title, 'Cambiato dopo', 'what the log holds since is still served')
  assert.deepEqual(asideIn(dir), [], 'no log set aside')
  const st = fs.statSync(path.join(dir, 'db.json'))
  const xp = lastLine(lib.logFile).xp
  assert.deepEqual([xp.size, xp.mtimeMs], [st.size, st.mtimeMs], 'the log knows the new stat')
  assert.match(xp.hash, /^[0-9a-f]{64}$/)
  lib.close()
  lib = new Library({ dataDir: dir })
  await lib.open()
  assert.equal(lib.getTrack(b.id).title, 'Cambiato dopo')
  lib.close()
})

test('db.json with other bytes of the same size (an older MPfy wrote it): the log still goes aside', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  const a = putFile(dir, track(T(1), { title: 'Primo' }))
  const db = (title) => JSON.stringify({ schema: 3, version: 7, tracks: [{ ...a, title }], covers: { track: {}, album: {} } })
  fs.writeFileSync(path.join(dir, 'db.json'), db('Primo'))
  let lib = new Library({ dataDir: dir })
  await lib.open()
  lib.updateTrack(a.id, { title: 'Nel log' })
  lib.close()
  fs.writeFileSync(path.join(dir, 'db.json'), db('Altro'))
  const later = new Date(Date.now() + 60000)
  fs.utimesSync(path.join(dir, 'db.json'), later, later)
  lib = new Library({ dataDir: dir })
  await lib.open()
  assert.equal(lib.getTrack(a.id).title, 'Altro')
  assert.equal(asideIn(dir).length, 1)
  lib.close()
})

test('a person .json copied without its times: the log stays the truth; other bytes of the same size still send it aside', (t) => {
  const dir = cleanup(t).dir(tmpDir())
  fs.mkdirSync(path.join(dir, 'users'))
  const jsonFile = path.join(dir, 'users', 'owner.json')
  const json = (id) => JSON.stringify({ schema: 1, version: 2, playlists: [], likes: [{ id, at: 1 }], recents: [] })
  fs.writeFileSync(jsonFile, json(T(1)))
  let users = new Users({ dataDir: dir })
  users.load()
  users.get('owner').like(T(2))
  users.close()
  touch(jsonFile)
  users = new Users({ dataDir: dir })
  users.load()
  assert.deepEqual(users.get('owner').likes.map((l) => l.id), [T(2), T(1)], 'the like made since is still there')
  assert.deepEqual(asideIn(path.join(dir, 'users')), [])
  users.close()
  const st = fs.statSync(jsonFile)
  const xp = fs.readFileSync(users.fileOf('owner'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.xp).pop().xp
  assert.deepEqual([xp.size, xp.mtimeMs], [st.size, st.mtimeMs], 'the log knows the new stat')
  // An older MPfy wrote other bytes of the same size.
  fs.writeFileSync(jsonFile, json(T(3)))
  const later = new Date(Date.now() + 120000)
  fs.utimesSync(jsonFile, later, later)
  users = new Users({ dataDir: dir })
  users.load()
  assert.deepEqual(users.get('owner').likes.map((l) => l.id), [T(3)])
  assert.equal(asideIn(path.join(dir, 'users')).length, 1)
  users.close()
})

test('db.json read in pieces gives what JSON.parse gives, at every cut, and refuses what it refuses', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  const file = path.join(dir, 'db.json')
  let seed = 11
  const rnd = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff
    return seed / 0x80000000
  }
  const words = ['a', 'tr"acks', 'x\\y', 'é€😀', '\u0000\n', '', ' ', ',}]', '__proto__', 'tracks']
  const value = (d) => {
    const x = rnd()
    if (d > 3 || x < 0.3) return [1, -2.5e10, true, false, null, 0, 'str', words[Math.floor(rnd() * words.length)]][Math.floor(rnd() * 8)]
    if (x < 0.65) return Array.from({ length: Math.floor(rnd() * 4) }, () => value(d + 1))
    const o = {}
    for (let i = 0; i < rnd() * 4; i++) o[words[Math.floor(rnd() * words.length)] + i] = value(d + 1)
    return o
  }
  for (let k = 0; k < 800; k++) {
    let text = JSON.stringify({ schema: 3, version: k, a: value(1), tracks: Array.from({ length: Math.floor(rnd() * 6) }, () => value(1)), covers: value(1) }, null, rnd() < 0.3 ? 2 : 0)
    if (rnd() < 0.15) text = '{"__proto__":{"p":1},' + text.slice(1)
    if (rnd() < 0.4) {
      const p = Math.floor(rnd() * text.length)
      const r = rnd()
      text = r < 0.33 ? text.slice(0, p) + text.slice(p + 1) : r < 0.66 ? text.slice(0, p) : text.slice(0, p) + '"]},:x1 '[Math.floor(rnd() * 8)] + text.slice(p)
    }
    fs.writeFileSync(file, text)
    // The bytes on disk (a cut through a surrogate pair is written as U+FFFD).
    text = fs.readFileSync(file, 'utf8')
    let want = null
    try {
      want = JSON.parse(text)
    } catch {}
    const got = []
    let r = null
    let refused = null
    try {
      r = await readDbJson(file, (el) => got.push(el), { chunk: 1 + Math.floor(rnd() * 40) })
    } catch (err) {
      assert.ok(err.corrupt, 'only a refusal: ' + err.message)
      refused = err
    }
    const shaped = want !== null && typeof want === 'object' && !Array.isArray(want) && Array.isArray(want.tracks)
    if (!shaped) {
      assert.ok(refused !== null || !r.tracks, JSON.stringify(text))
      continue
    }
    if (refused !== null) {
      assert.match(refused.message, /tracks/, 'refused only for "tracks" twice: ' + JSON.stringify(text))
      continue
    }
    const { tracks, ...head } = want
    assert.deepEqual(got, tracks, JSON.stringify(text))
    assert.equal(JSON.stringify(r.head), JSON.stringify(head), JSON.stringify(text))
    assert.equal(Object.getPrototypeOf(r.head), Object.prototype)
  }
  // The schema after the tracks (no MPfy writes it so): the same library as before it.
  const a = putFile(dir, track(T(1)))
  fs.writeFileSync(file, JSON.stringify({ tracks: [{ ...a, quality: 'x' }], schema: 2, version: 3 }))
  const lib = new Library({ dataDir: dir })
  await lib.open()
  assert.deepEqual([...lib.tracks.keys()], [a.id])
  lib.close()
})

test('a db.json of 30,000 tracks (22 MB) opens under a 48 MB heap', (t) => {
  const dir = cleanup(t).dir(tmpDir())
  const fd = fs.openSync(path.join(dir, 'db.json'), 'w')
  fs.writeSync(fd, '{"schema":3,"version":5,"tracks":[')
  const sig = Buffer.alloc(256)
  for (let i = 0; i < 30000; i++) {
    for (let k = 0; k < 256; k++) sig[k] = (i * 31 + k * 7) & 255
    const id = i.toString(16).padStart(8, '0') + 'ab'.repeat(8)
    const t = track(id, { title: 'Brano numero ' + i, album: 'Album ' + (i % 2000), size: 4000000 + i, addedAt: 1700000000000 + i, fp: { d: 201, b: 32, s: sig.toString('base64') }, fpState: 'ok' })
    fs.writeSync(fd, (i ? ',' : '') + JSON.stringify(t))
  }
  fs.writeSync(fd, '],"covers":{"track":{},"album":{}}}')
  fs.closeSync(fd)
  const out = spawnSync(process.execPath, ['--max-old-space-size=48', fileURLToPath(import.meta.url)], {
    env: { ...process.env, MPFY_DB_HEAP_DIR: dir },
    encoding: 'utf8',
    timeout: 120000
  })
  assert.equal(out.status, 0, 'the child ended with ' + out.status + ': ' + (out.stderr || '').slice(0, 400))
  const line = out.stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop()
  assert.deepEqual(JSON.parse(line), { status: 'ok', dropped: 30000 })
  rmDir(dir)
})
