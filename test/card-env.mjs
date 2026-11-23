// A memory card for the tests: a folder <cards>/TEST-0001 whose calls go through
// an `io` that says it is a mounted volume, gives each place its own free space,
// logs every write under <cards>, refuses a rename across places (EXDEV, as two
// volumes do), and can hang, corrupt or fail the card's calls on demand.

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createMPfy } from '../server/app.mjs'
import { PLACE_IO } from '../server/places.mjs'
import { tmpDir, fakeFfmpeg, request, json, makeWav } from './helpers.mjs'

export const GIB = 1024 ** 3
export const VOLUME = 'TEST-0001'
export const idOf = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 24)
export const hiWav = (freq, seconds = 1) => makeWav({ seconds, sampleRate: 44100, freq })

function under (p, root) {
  const rel = path.relative(root, path.resolve(p))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * @param {object} c  cleanup(t)
 * @param {string} dataDir
 */
export function cardEnv (c, dataDir) {
  const cards = c.dir(tmpDir('mpfy-cards-'))
  const vol = path.join(cards, VOLUME)
  fs.mkdirSync(vol)
  const st = {
    cardFree: 30 * GIB,
    cardTotal: 32 * GIB,
    internalFree: 40 * GIB,
    internalTotal: 60 * GIB,
    log: [], // writes under <cards>, in order
    inFlight: 0,
    maxInFlight: 0,
    hang: false, // card calls never answer
    fail: null, // (op, file) => an error code to throw, or null
    readHook: null, // (file, buf, dropped) => the bytes a read gives
    onRename: null, // (from, to) called before a rename under <cards>
    openHook: null, // async (file, flags) before an open (internal files too)
    dropHook: null, // (file) when a copy's cached pages are dropped (its bytes all written)
    sameDev: new Set(), // volume names whose folder is not a mount
    crossRenames: 0, // renames tried from one place to the other (never: a file crosses by a copy)
    dropped: new Set()
  }
  const rel = (p) => path.relative(cards, path.resolve(p)).split(path.sep).join('/')
  const onCard = (p) => under(p, cards)
  const rec = (op, p) => { if (onCard(p)) st.log.push(op + ' ' + rel(p)) }
  const gate = (fn) => async (p, ...rest) => {
    if (!onCard(p)) return fn(p, ...rest)
    st.inFlight++
    st.maxInFlight = Math.max(st.maxInFlight, st.inFlight)
    try {
      if (st.hang) await new Promise(() => {})
      return await fn(p, ...rest)
    } finally {
      st.inFlight--
    }
  }
  const check = (op, p) => {
    const code = st.fail && onCard(p) ? st.fail(op, p) : null
    if (code) throw Object.assign(new Error(code + ': ' + op + ' ' + rel(p)), { code })
  }
  const wrapFh = (fh, file) => ({
    async read (buf, off, len, pos) {
      check('read', file)
      const r = await fh.read(buf, off, len, pos)
      if (st.readHook) {
        const got = st.readHook(file, buf.subarray(off, off + r.bytesRead), st.dropped.has(path.resolve(file)))
        if (got) got.copy(buf, off)
      }
      return r
    },
    async write (buf, off, len) {
      check('write', file)
      return fh.write(buf, off, len)
    },
    async sync () {
      rec('fsync', file)
      return fh.sync()
    },
    close: () => fh.close()
  })
  const io = {
    devOf: async (p) => {
      await fs.promises.stat(p)
      const r = path.resolve(p)
      return r === path.resolve(cards) || st.sameDev.has(path.basename(r)) ? 1 : 2
    },
    statfs: gate(async (p) => ({ bavail: Math.floor(st.cardFree / 4096), bsize: 4096, blocks: Math.floor(st.cardTotal / 4096) })),
    mkdir: gate(async (p) => {
      check('mkdir', p)
      rec('mkdir', p)
      return PLACE_IO.mkdir(p)
    }),
    rename: gate(async (a, b) => {
      if (onCard(a) !== onCard(b) && (under(a, dataDir) || under(b, dataDir))) {
        st.crossRenames++
        throw Object.assign(new Error('EXDEV: cross-device link'), { code: 'EXDEV' })
      }
      check('rename', a)
      if (onCard(a) && st.onRename) st.onRename(a, b)
      if (onCard(a)) st.log.push('rename ' + rel(a) + ' -> ' + rel(b))
      return PLACE_IO.rename(a, b)
    }),
    unlink: gate(async (p) => {
      check('unlink', p)
      rec('unlink', p)
      return PLACE_IO.unlink(p)
    }),
    rmdir: gate(async (p) => {
      rec('rmdir', p)
      return PLACE_IO.rmdir(p)
    }),
    open: gate(async (p, flags = 'r', mode) => {
      check('open', p)
      if (st.openHook) await st.openHook(p, flags)
      if (flags !== 'r') rec('open-' + flags, p)
      return wrapFh(await fs.promises.open(p, flags, mode), p)
    }),
    readdir: gate(async (p) => {
      check('readdir', p)
      return PLACE_IO.readdir(p)
    }),
    stat: gate(async (p) => {
      check('stat', p)
      return PLACE_IO.stat(p)
    }),
    readFile: gate(async (p) => {
      check('readFile', p)
      return PLACE_IO.readFile(p)
    }),
    access: gate((p, mode) => PLACE_IO.access(p, mode)),
    watch: (dir, fn) => fs.watch(dir, fn),
    dropCache: async (p) => {
      rec('drop', p)
      st.dropped.add(path.resolve(p))
      if (st.dropHook) st.dropHook(p)
    }
  }
  const internalStatfs = async () => ({ bavail: Math.floor(st.internalFree / 4096), bsize: 4096, blocks: Math.floor(st.internalTotal / 4096) })
  return { cards, vol, root: path.join(vol, 'MPfy'), st, io, internalStatfs, rel }
}

/** A source with that card under its cards folder (not chosen). */
export async function startWithCard (c, env, dataDir, { placesOptions = {}, ffmpeg = true, ...opts } = {}) {
  const fake = ffmpeg ? fakeFfmpeg(c.dir(tmpDir('mpfy-ff-'))) : null
  const app = c.close(await createMPfy({
    dataDir,
    port: 0,
    adminPort: 0,
    p2p: false,
    debounceMs: 10,
    ffmpeg: fake ? fake.command : null,
    cardsDir: env.cards,
    statfs: env.internalStatfs,
    placesOptions: { io: env.io, confirmMs: 0, graceMs: 300, watch: false, streamQuietMs: 50, ...placesOptions },
    ...opts
  }))
  await app.jobsStarted
  const call = async (method, p, body) => {
    const r = await request(app.ports.http, method, p, body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
    return { status: r.status, body: r.body.length ? json(r) : null, headers: r.headers, raw: r.body }
  }
  const upload = async (name, buf) => {
    const r = await request(app.ports.http, 'PUT', '/api/upload/' + encodeURIComponent(name), { body: buf })
    assert.equal(r.status, 200, r.body.toString())
    return json(r).track
  }
  return { app, fake, call, upload }
}

/** Choose the card and wait until every original is on it. */
export async function useCard (s, { wait = true } = {}) {
  const r = await s.call('PUT', '/api/admin/storage', { use: VOLUME })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  if (wait) await settle(s.app)
  return r.body
}

/** Until the jobs (the move included) have nothing left. */
export async function settle (app) {
  for (let i = 0; i < 200; i++) {
    await app.jobs.idle()
    await new Promise((resolve) => setTimeout(resolve, 20))
    if (!app.jobs.busy) return
  }
  throw new Error('the jobs never settled')
}

/** library.log, its change lines. */
export function logLines (dataDir) {
  return fs.readFileSync(path.join(dataDir, 'library.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter(Array.isArray)
}
