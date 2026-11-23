// The profile photo in the client core: /local/profile/photo (GET, HEAD, PUT the
// JPEG's bytes, DELETE) and its guards, the files next to the state file (written
// before the state points to them, swept at start), states and identity files
// from before photos, and the sync with real sources (server/app.mjs) on a local
// HyperDHT testnet: the newest photo wins on every device of the profile, a
// removal too, and only bytes that hash to what the source announced are taken.

import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import createTestnet from 'hyperdht/testnet.js'
import { createMPfy } from '../server/app.mjs'
import { createClientCore } from '../client-core/index.js'
import { profileKeys, buildIdentity, profileIdText } from '../client-core/identity.js'
import { tmpDir, request, json, waitFor, cleanup, fakeJpeg } from './helpers.mjs'

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web')
const JPEG = { 'content-type': 'image/jpeg' }
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
const withoutTime = ({ exportedAt, ...rest }) => rest

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

async function source (t, { name = 'Fonte' } = {}) {
  const c = cleanup(t)
  const dataDir = c.dir(tmpDir('mpfy-ccf-src-'))
  const app = await createMPfy({
    dataDir, port: 0, adminPort: 0, p2p: true, waitForDht: true, dht: node(), ffmpeg: null, fpcalc: null, sevenZip: null, debounceMs: 10, name
  })
  c.close(app)
  return { app, dir: dataDir, id: app.serverPublicKey.slice(0, 8) }
}

async function core (t, { statePath = null, deviceName = 'Banco di prova', ...opts } = {}) {
  const c = cleanup(t)
  const file = statePath || path.join(c.dir(tmpDir('mpfy-ccf-core-')), 'state.json')
  const events = []
  const logs = []
  const instance = createClientCore({ statePath: file, webRoot: WEB, port: 0, deviceName, onEvent: (e) => events.push(e), log: (l) => logs.push(l), dht: node(), ...opts })
  const { port } = await instance.start()
  const h = {
    core: instance,
    port,
    statePath: file,
    dir: path.dirname(file),
    events,
    logs,
    close: () => instance.stop(),
    readState: () => JSON.parse(fs.readFileSync(file, 'utf8')),
    call: (method, p, body, headers = {}) => request(port, method, p, { body, headers, timeout: 90000 }),
    get: async (p) => json(await request(port, 'GET', p, { timeout: 30000 })),
    view: async () => json(await request(port, 'GET', '/local/profile', { timeout: 30000 })).profile,
    put: async (bytes) => {
      const res = await request(port, 'PUT', '/local/profile/photo', { body: bytes, headers: JPEG, timeout: 30000 })
      assert.equal(res.status, 200, res.body.toString())
      return json(res).profile
    },
    photos: () => fs.readdirSync(path.dirname(file)).filter((n) => n.startsWith(path.basename(file) + '.photo-')).sort(),
    entry: async (id) => (await h.get('/local/sources')).sources.find((s) => s.id === id)
  }
  c.close(h)
  return h
}

async function expectError (pending, status, code, error = undefined) {
  const res = await pending
  assert.equal(res.status, status, res.body.toString())
  const body = json(res)
  assert.equal(body.code, code, res.body.toString())
  if (error !== undefined) assert.equal(body.error, error)
  return body
}

async function makeProfile (h, name) {
  const res = await h.call('POST', '/local/profile', { name })
  assert.equal(res.status, 201, res.body.toString())
  return json(res).profile
}

async function addSource (h, src) {
  const res = await h.call('POST', '/local/sources', { code: src.app.code })
  assert.equal(res.status, 201, res.body.toString())
  const entry = json(res).source
  await waitFor(async () => (await h.entry(entry.id))?.connected, { timeout: 30000, what: 'the link to ' + src.id })
  return entry
}

// The name of a photo's file next to a state file named state.json.
const fileName = (bytes) => 'state.json.photo-' + sha(bytes) + '.jpg'
const onSource = (s, id) => {
  const rec = s.app.profiles.get(id)
  return rec === null ? null : [rec.photo, rec.photoUpdatedAt]
}
// The photo files in a folder that hold these bytes, whatever their name.
const filesOf = (dir, bytes) => fs.readdirSync(dir).filter((n) => n.includes(sha(bytes)))

// Holds every source's read of a photo file (GET /api/profile/photo) until
// release(); `reached` resolves when the first one arrives.
function holdPhotoReads (t) {
  const stat = fs.promises.stat
  let release = null
  const held = new Promise((resolve) => { release = resolve })
  let arrived = null
  const reached = new Promise((resolve) => { arrived = resolve })
  fs.promises.stat = async function (file, ...rest) {
    if (typeof file === 'string' && file.includes('profile-photos')) {
      arrived()
      await held
    }
    return stat.call(this, file, ...rest)
  }
  const done = () => {
    fs.promises.stat = stat
    release()
  }
  t.after(done)
  return { reached, release: done }
}

// ------------------------------------------------------------------ tests

test('local routes: no_profile, bad_photo (type, bytes, size), PUT, GET, HEAD, 304, DELETE; the file beside the state; the profile event; the identity file never changes for a photo', { timeout: 60000 }, async (t) => {
  const a = await core(t)
  await expectError(a.call('GET', '/local/profile/photo'), 404, 'no_profile', 'Nessun profilo')
  await expectError(a.call('PUT', '/local/profile/photo', fakeJpeg(1), JPEG), 404, 'no_profile', 'Nessun profilo')
  await expectError(a.call('DELETE', '/local/profile/photo'), 404, 'no_profile', 'Nessun profilo')
  assert.equal((await a.call('HEAD', '/local/profile/photo')).status, 404)

  const p = await makeProfile(a, 'Bacca')
  assert.equal(p.photo, null, 'a new profile has no photo')
  assert.deepEqual([a.readState().profile.photo, a.readState().profile.photoUpdatedAt], [null, 0])
  await expectError(a.call('GET', '/local/profile/photo'), 404, 'no_photo', 'Nessuna foto')
  assert.equal((await a.call('HEAD', '/local/profile/photo')).status, 404)
  const identities = a.events.filter((e) => e.type === 'identity').length
  const exported = await a.get('/local/profile/export')

  // Refused: another type, no type, bytes that are no JPEG, nothing, one byte too many.
  const one = fakeJpeg(1)
  for (const headers of [{}, { 'content-type': 'image/png' }, { 'content-type': 'application/json' }, { 'content-type': 'image/jpegx' }]) {
    await expectError(a.call('PUT', '/local/profile/photo', one, headers), 400, 'bad_photo', 'Foto non valida')
  }
  for (const bytes of [Buffer.from('<svg/>'), Buffer.alloc(0), fakeJpeg(1, 48 * 1024 + 1), one.subarray(0, 5000)]) {
    await expectError(a.call('PUT', '/local/profile/photo', bytes, JPEG), 400, 'bad_photo', 'Foto non valida')
  }
  await expectError(a.call('PUT', '/local/profile/photo', Buffer.alloc(70000, 0xff), JPEG), 413, 'too_large')
  await expectError(a.call('POST', '/local/profile/photo', one, JPEG), 405, 'method_not_allowed')
  assert.deepEqual(a.photos(), [], 'nothing written for a refused photo')
  assert.equal(a.readState().profile.photoUpdatedAt, 0)

  // Taken: the bytes beside the state file, the state names them, the host hears it.
  const t0 = Date.now()
  const res = await a.call('PUT', '/local/profile/photo', one, { 'content-type': 'Image/JPEG; charset=binary' })
  assert.equal(res.status, 200, res.body.toString())
  const v1 = json(res).profile
  assert.deepEqual(v1, { id: p.id, name: 'Bacca', nameUpdatedAt: p.nameUpdatedAt, photo: sha(one), pid: p.pid })
  let st = a.readState().profile
  assert.equal(st.photo, sha(one))
  assert.ok(st.photoUpdatedAt >= t0 && st.photoUpdatedAt <= Date.now())
  assert.deepEqual(a.photos(), [fileName(one)])
  assert.ok(fs.readFileSync(path.join(a.dir, fileName(one))).equals(one))
  assert.deepEqual(a.events.filter((e) => e.type === 'profile').pop(), { type: 'profile', profile: v1 })
  assert.deepEqual(await a.view(), v1)

  // Read back as the page's <img> asks for it (?v= is only for its cache).
  for (const target of ['/local/profile/photo', '/local/profile/photo?v=' + sha(one)]) {
    const r = await a.call('GET', target)
    assert.equal(r.status, 200, target)
    assert.ok(r.body.equals(one), target)
    assert.equal(r.headers['content-type'], 'image/jpeg')
    assert.equal(r.headers.etag, '"' + sha(one) + '"')
    assert.equal(r.headers['cache-control'], 'no-cache')
    assert.equal(Number(r.headers['content-length']), one.length)
  }
  let r = await a.call('GET', '/local/profile/photo', undefined, { 'if-none-match': '"' + sha(one) + '"' })
  assert.equal(r.status, 304)
  assert.equal(r.body.length, 0)
  assert.equal(r.headers.etag, '"' + sha(one) + '"')
  assert.equal((await a.call('GET', '/local/profile/photo', undefined, { 'if-none-match': '"' + 'a'.repeat(64) + '"' })).status, 200)
  r = await a.call('HEAD', '/local/profile/photo')
  assert.equal(r.status, 200)
  assert.equal(r.body.length, 0)
  assert.equal(Number(r.headers['content-length']), one.length)

  // Another one: a newer time, and only its file is left.
  const two = fakeJpeg(2)
  const v2 = await a.put(two)
  assert.equal(v2.photo, sha(two))
  const t1 = st.photoUpdatedAt
  st = a.readState().profile
  assert.ok(st.photoUpdatedAt > t1)
  assert.deepEqual(a.photos(), [fileName(two)])
  assert.ok((await a.call('GET', '/local/profile/photo')).body.equals(two))

  // The identity file knows nothing of photos: no event, the same export.
  assert.equal(a.events.filter((e) => e.type === 'identity').length, identities, 'no identity event for a photo')
  const after = await a.get('/local/profile/export')
  assert.deepEqual(withoutTime(after.identity), withoutTime(exported.identity))
  assert.deepEqual(Object.keys(after.identity.profile), ['id', 'secret', 'name', 'nameUpdatedAt'])
  assert.deepEqual(withoutTime(buildIdentity(a.readState())), withoutTime(exported.identity))

  // A photo file that cannot be written changes nothing: the state keeps naming a
  // file that is there.
  const three = fakeJpeg(3)
  fs.mkdirSync(path.join(a.dir, fileName(three) + '.tmp'))
  await expectError(a.call('PUT', '/local/profile/photo', three, JPEG), 500, 'failed')
  assert.deepEqual([a.readState().profile.photo, a.readState().profile.photoUpdatedAt], [sha(two), st.photoUpdatedAt])
  assert.ok((await a.call('GET', '/local/profile/photo')).body.equals(two))
  fs.rmdirSync(path.join(a.dir, fileName(three) + '.tmp'))
  assert.deepEqual(a.photos(), [fileName(two)])

  // Removed: a newer time, no file left; removed again: a newer time still.
  r = await a.call('DELETE', '/local/profile/photo')
  assert.equal(r.status, 200, r.body.toString())
  assert.deepEqual(json(r).profile, { ...v2, photo: null })
  const gone = a.readState().profile
  assert.equal(gone.photo, null)
  assert.ok(gone.photoUpdatedAt > st.photoUpdatedAt)
  assert.deepEqual(a.photos(), [])
  await expectError(a.call('GET', '/local/profile/photo'), 404, 'no_photo')
  assert.equal(a.events.filter((e) => e.type === 'profile').pop().profile.photo, null)
  assert.equal((await a.call('DELETE', '/local/profile/photo')).status, 200)
  assert.ok(a.readState().profile.photoUpdatedAt > gone.photoUpdatedAt, 'every removal is the newest word')
  assert.equal(a.events.filter((e) => e.type === 'identity').length, identities)
})

test('guards: the page\'s <img> loads the photo with the token cookie; no token, a wrong token or another Origin are refused', { timeout: 60000 }, async (t) => {
  const token = crypto.randomBytes(32).toString('hex')
  const a = await core(t, { token })
  const ok = { 'x-mpfy-token': token }
  assert.equal((await request(a.port, 'POST', '/local/profile', { body: { name: 'Bacca' }, headers: ok })).status, 201)
  const one = fakeJpeg(1)
  const refused = (res, what) => {
    assert.equal(res.status, 403, what)
    assert.deepEqual(json(res), { error: 'Richiesta rifiutata' }, what)
  }
  refused(await request(a.port, 'PUT', '/local/profile/photo', { body: one, headers: JPEG }), 'PUT without the token')
  refused(await request(a.port, 'PUT', '/local/profile/photo', { body: one, headers: { ...JPEG, ...ok, origin: 'http://evil.example' } }), 'PUT from another site')
  assert.equal(a.readState().profile.photo, null)
  assert.equal((await request(a.port, 'PUT', '/local/profile/photo', { body: one, headers: { ...JPEG, ...ok, origin: 'http://127.0.0.1:' + a.port } })).status, 200)

  const target = '/local/profile/photo?v=' + sha(one)
  const cookie = { cookie: 'mpfy_token=' + token }
  for (const headers of [cookie, { ...cookie, origin: 'http://127.0.0.1:' + a.port }, ok]) {
    const r = await request(a.port, 'GET', target, { headers })
    assert.equal(r.status, 200, JSON.stringify(headers))
    assert.ok(r.body.equals(one))
  }
  refused(await request(a.port, 'GET', target), 'no token')
  refused(await request(a.port, 'GET', target, { headers: { cookie: 'mpfy_token=' + token.slice(0, -2) + '00' } }), 'a wrong token')
  refused(await request(a.port, 'GET', target, { headers: { ...cookie, origin: 'http://evil.example' } }), 'another site')
  refused(await request(a.port, 'DELETE', '/local/profile/photo'), 'DELETE without the token')
  assert.equal(a.readState().profile.photo, sha(one))
  const moved = await request(a.port, 'GET', target, { headers: { ...cookie, host: 'localhost:' + a.port } })
  assert.equal(moved.status, 308, 'localhost goes to the one origin, like every request')
  assert.equal(moved.headers.location, 'http://127.0.0.1:' + a.port + target)
})

test('files: a state from before photos loads with none; files the state does not name are swept at start; a missing file is no photo at time 0; a time ahead still gets a newer one; a new profile, a code and an identity file start without a photo', { timeout: 90000 }, async (t) => {
  const dir = cleanup(t).dir(tmpDir('mpfy-ccf-old-'))
  const statePath = path.join(dir, 'state.json')
  const keys = profileKeys(crypto.randomBytes(32))
  const older = { clientSeed: crypto.randomBytes(32).toString('hex'), profile: { id: keys.id, secret: keys.secret, name: 'Bacca', nameUpdatedAt: 5, createdAt: 5 }, recovery: null, recoveryDeletes: [], sources: [] }
  fs.writeFileSync(statePath, JSON.stringify(older, null, 2) + '\n')
  const stray = ['state.json.photo-' + 'a'.repeat(64) + '.jpg', 'state.json.photo-' + 'b'.repeat(64) + '.jpg.tmp']
  for (const name of stray) fs.writeFileSync(path.join(dir, name), 'x')
  // Not this state file's: another state file's photo, anything else.
  const others = ['altro.jpg', 'altro.json.photo-' + 'c'.repeat(64) + '.jpg', 'profile-photo-' + 'd'.repeat(64) + '.jpg']
  for (const name of others) fs.writeFileSync(path.join(dir, name), 'not ours')
  let a = await core(t, { statePath })
  assert.deepEqual(await a.view(), { id: keys.id, name: 'Bacca', nameUpdatedAt: 5, photo: null, pid: profileIdText(keys.id) })
  assert.deepEqual([a.readState().profile.photo, a.readState().profile.photoUpdatedAt], [null, 0], 'written again with the fields')
  assert.deepEqual(a.photos(), [], 'files no state names are gone')
  for (const name of others) assert.ok(fs.existsSync(path.join(dir, name)), name + ' stays')

  // A photo, then a stray file again: the next start keeps only the named one.
  const one = fakeJpeg(1)
  await a.put(one)
  await a.close()
  for (const name of stray) fs.writeFileSync(path.join(dir, name), 'x')
  a = await core(t, { statePath })
  assert.deepEqual(a.photos(), [fileName(one)])
  assert.ok((await a.call('GET', '/local/profile/photo')).body.equals(one))
  assert.deepEqual(a.events.filter((e) => e.type === 'profile'), [], 'no change at start')
  await a.close()

  // Its file gone (or holding something else): no photo, at time 0, so a source
  // that has it gives it back and it never goes out as a removal.
  for (const spoil of [(f) => fs.unlinkSync(f), (f) => fs.writeFileSync(f, fakeJpeg(9))]) {
    a = await core(t, { statePath })
    await a.put(one)
    await a.close()
    spoil(path.join(dir, fileName(one)))
    a = await core(t, { statePath })
    assert.equal((await a.view()).photo, null)
    assert.deepEqual([a.readState().profile.photo, a.readState().profile.photoUpdatedAt], [null, 0])
    assert.deepEqual(a.photos(), [])
    assert.ok(a.logs.some((l) => /photo file missing/.test(l)))
    await a.close()
  }

  // A time ahead (a source's, up to 5 minutes): a change here is newer still.
  const ahead = Date.now() + 60000
  const st = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  fs.writeFileSync(path.join(dir, fileName(one)), one)
  st.profile.photo = sha(one)
  st.profile.photoUpdatedAt = ahead
  fs.writeFileSync(statePath, JSON.stringify(st))
  a = await core(t, { statePath })
  assert.equal((await a.view()).photo, sha(one))
  await a.put(fakeJpeg(2))
  assert.ok(a.readState().profile.photoUpdatedAt > ahead, 'newer than the one it replaces')
  assert.equal((await a.call('DELETE', '/local/profile/photo')).status, 200)
  const removedAt = a.readState().profile.photoUpdatedAt
  assert.ok(removedAt > ahead)

  // Another profile on this device starts without a photo: by its code, by its file.
  await a.put(one)
  const code = (await a.get('/local/profile/code')).code
  const identity = (await a.get('/local/profile/export')).identity
  assert.equal(identity.profile.photo, undefined)
  for (const body of [{ code }, { identity }]) {
    const b = await core(t)
    fs.writeFileSync(path.join(b.dir, fileName(one)), one) // left there by nobody knows what
    assert.equal((await b.call('POST', '/local/profile/import', body)).status, 200)
    assert.equal((await b.view()).photo, null)
    assert.deepEqual([b.readState().profile.photo, b.readState().profile.photoUpdatedAt], [null, 0])
    assert.deepEqual(b.photos(), [], 'and no photo file next to it')
  }
  const c = await core(t)
  fs.writeFileSync(path.join(c.dir, fileName(one)), one)
  assert.equal((await makeProfile(c, 'Sara')).photo, null)
  assert.deepEqual(c.photos(), [])
})

test('files: a photo file another program holds at start (EBUSY, an antivirus on Windows) is no lost photo: the state, its time and the file stay', { timeout: 60000 }, async (t) => {
  const a0 = await core(t)
  await makeProfile(a0, 'Bacca')
  const one = fakeJpeg(1)
  await a0.put(one)
  const before = a0.readState().profile
  await a0.close()
  const files = filesOf(a0.dir, one)
  assert.equal(files.length, 1)

  // The first read of the photo file fails, as a file being scanned does.
  const real = fs.readFileSync
  let failed = 0
  fs.readFileSync = function (file, ...rest) {
    if (failed === 0 && String(file).includes(sha(one))) {
      failed++
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
    }
    return real.call(this, file, ...rest)
  }
  let a = null
  try {
    a = await core(t, { statePath: a0.statePath })
  } finally {
    fs.readFileSync = real
  }
  assert.equal(failed, 1, 'the read at start failed')
  const st = a.readState().profile
  assert.deepEqual([st.photo, st.photoUpdatedAt], [before.photo, before.photoUpdatedAt], 'the state still names the photo with its time')
  assert.deepEqual(filesOf(a.dir, one), files, 'its file is still there')
  assert.ok((await a.call('GET', '/local/profile/photo')).body.equals(one))
  assert.ok(!a.logs.some((l) => /photo file missing/.test(l)), a.logs.join(' | '))
})

test('files: two state files in one folder (two clients on one computer) never sweep each other\'s photo: at start, after a new profile, after a code', { timeout: 60000 }, async (t) => {
  const dir = cleanup(t).dir(tmpDir('mpfy-ccf-two-'))
  const one = fakeJpeg(1)
  const two = fakeJpeg(2)
  let a = await core(t, { statePath: path.join(dir, 'a.json') })
  await makeProfile(a, 'Uno')
  await a.put(one)
  const b = await core(t, { statePath: path.join(dir, 'b.json') })
  await makeProfile(b, 'Due')
  await b.put(two)
  const c = await core(t, { statePath: path.join(dir, 'c.json') })
  assert.equal((await c.call('POST', '/local/profile/import', { code: (await a.get('/local/profile/code')).code })).status, 200)
  for (const [h, bytes] of [[a, one], [b, two]]) {
    const r = await h.call('GET', '/local/profile/photo')
    assert.equal(r.status, 200, r.body.toString())
    assert.ok(r.body.equals(bytes))
  }
  await a.close()
  a = await core(t, { statePath: path.join(dir, 'a.json') })
  assert.equal((await a.view()).photo, sha(one), 'kept across a start')
  assert.ok((await a.call('GET', '/local/profile/photo')).body.equals(one))
  assert.ok((await b.call('GET', '/local/profile/photo')).body.equals(two))
  assert.deepEqual([filesOf(dir, one).length, filesOf(dir, two).length], [1, 1])
})

test('sync: a photo reaches the source at once and the other device of the profile; a newer one wins both ways, an older one from a source never; a removal too; equal times ask nothing', { timeout: 240000 }, async (t) => {
  const s1 = await source(t, { name: 'Uno' })
  const s2 = await source(t, { name: 'Due' })
  // What reaches the sources' photo routes: PUT stores, GET reads the file.
  const calls = { put: 0, get: 0 }
  for (const s of [s1, s2]) {
    const setPhoto = s.app.profiles.setPhoto.bind(s.app.profiles)
    const photoFile = s.app.profiles.photoFile.bind(s.app.profiles)
    s.app.profiles.setPhoto = (...args) => {
      calls.put++
      return setPhoto(...args)
    }
    s.app.profiles.photoFile = (...args) => {
      calls.get++
      return photoFile(...args)
    }
  }
  const a = await core(t, { deviceName: 'Telefono' })
  const p = await makeProfile(a, 'Bacca')
  await addSource(a, s1)
  await addSource(a, s2)
  assert.deepEqual([onSource(s1, p.id), onSource(s2, p.id)], [[null, 0], [null, 0]])

  // A photo made here, the largest there is (48 KB): on both sources within
  // moments (not at the 5-minute sync).
  const one = fakeJpeg(1, 48 * 1024)
  await a.put(one)
  const t1 = a.readState().profile.photoUpdatedAt
  await waitFor(() => [s1, s2].every((s) => onSource(s, p.id)[0] === sha(one)), { timeout: 20000, what: 'the photo on both sources' })
  assert.deepEqual(onSource(s1, p.id), [sha(one), t1], 'with its time')
  assert.ok(fs.readFileSync(s1.app.profiles.photoFile(p.id)).equals(one))

  // The same person on a PC, by the profile code, on the first source only.
  const b = await core(t, { deviceName: 'PC' })
  assert.equal((await b.call('POST', '/local/profile/import', { code: (await a.get('/local/profile/code')).code })).status, 200)
  await addSource(b, s1)
  await waitFor(async () => (await b.view()).photo === sha(one), { timeout: 20000, what: 'the photo taken from the source' })
  assert.equal(b.readState().profile.photoUpdatedAt, t1)
  assert.ok((await b.call('GET', '/local/profile/photo')).body.equals(one), 'the same bytes, served here')
  assert.deepEqual(b.photos(), [fileName(one)])
  assert.ok(b.events.some((e) => e.type === 'profile' && e.profile.photo === sha(one)), 'the host heard it')

  // Equal times everywhere: a sync asks nothing about the photo.
  const quiet = { ...calls }
  assert.deepEqual(json(await a.call('POST', '/local/sync')), { ok: true })
  assert.deepEqual(json(await b.call('POST', '/local/sync')), { ok: true })
  assert.deepEqual(calls, quiet, 'no photo request when nothing changed')

  // A newer photo on the PC reaches the first source; the second still has the older.
  const two = fakeJpeg(2)
  await b.put(two)
  const t2 = b.readState().profile.photoUpdatedAt
  assert.ok(t2 > t1)
  await waitFor(() => onSource(s1, p.id)[0] === sha(two), { timeout: 20000, what: 'the newer photo on the first source' })
  assert.deepEqual(onSource(s2, p.id), [sha(one), t1])
  // The PC meets the second source: the older photo there never wins, the newer goes there.
  await addSource(b, s2)
  await waitFor(() => onSource(s2, p.id)[0] === sha(two), { timeout: 20000, what: 'the newer photo sent to the second source' })
  assert.deepEqual([(await b.view()).photo, b.readState().profile.photoUpdatedAt], [sha(two), t2], 'the PC kept its own')
  assert.deepEqual(b.photos(), [fileName(two)])
  // The phone takes the newer one at its next sync, with its time.
  assert.deepEqual(json(await a.call('POST', '/local/sync')), { ok: true })
  await waitFor(async () => (await a.view()).photo === sha(two), { timeout: 20000, what: 'the phone took the newer photo' })
  assert.equal(a.readState().profile.photoUpdatedAt, t2)
  assert.ok((await a.call('GET', '/local/profile/photo')).body.equals(two))
  assert.deepEqual(a.photos(), [fileName(two)], 'the older file went')

  // Removed on the phone: gone from both sources, then from the PC at its sync.
  assert.equal((await a.call('DELETE', '/local/profile/photo')).status, 200)
  const t3 = a.readState().profile.photoUpdatedAt
  await waitFor(() => [s1, s2].every((s) => onSource(s, p.id)[0] === null), { timeout: 20000, what: 'the removal on both sources' })
  assert.deepEqual(onSource(s1, p.id), [null, t3])
  assert.equal(s1.app.profiles.photoFile(p.id), null)
  assert.deepEqual(json(await b.call('POST', '/local/sync')), { ok: true })
  await waitFor(async () => (await b.view()).photo === null, { timeout: 20000, what: 'the removal taken on the PC' })
  assert.equal(b.readState().profile.photoUpdatedAt, t3)
  assert.deepEqual(b.photos(), [])
  await expectError(b.call('GET', '/local/profile/photo'), 404, 'no_photo')
  assert.ok(!a.logs.concat(b.logs).some((l) => /photo not/.test(l)), 'nothing went wrong on the way: ' + a.logs.concat(b.logs).filter((l) => /photo/.test(l)).join(' | '))
})

test('sync: bytes that do not hash to the photo the source announced are never taken; the right ones are', { timeout: 180000 }, async (t) => {
  const s = await source(t, { name: 'Uno' })
  const a = await core(t, { deviceName: 'Telefono' })
  const p = await makeProfile(a, 'Bacca')
  await addSource(a, s)
  const one = fakeJpeg(1)
  await a.put(one)
  await waitFor(() => onSource(s, p.id)[0] === sha(one), { timeout: 20000, what: 'the photo on the source' })
  // The file on the source now holds another valid JPEG under the same name.
  const file = s.app.profiles.photoFile(p.id)
  fs.writeFileSync(file, fakeJpeg(66))

  const b = await core(t, { deviceName: 'PC' })
  assert.equal((await b.call('POST', '/local/profile/import', { code: (await a.get('/local/profile/code')).code })).status, 200)
  await addSource(b, s)
  assert.deepEqual(json(await b.call('POST', '/local/sync')), { ok: true })
  await waitFor(() => b.logs.some((l) => /photo not taken \(not the one announced\)/.test(l)), { timeout: 20000, what: 'the refusal logged' })
  assert.equal((await b.view()).photo, null, 'not taken')
  assert.deepEqual([b.readState().profile.photo, b.readState().profile.photoUpdatedAt], [null, 0])
  assert.deepEqual(b.photos(), [], 'nothing written here')
  await expectError(b.call('GET', '/local/profile/photo'), 404, 'no_photo')

  // The right bytes again: taken at the next sync.
  fs.writeFileSync(file, one)
  assert.deepEqual(json(await b.call('POST', '/local/sync')), { ok: true })
  await waitFor(async () => (await b.view()).photo === sha(one), { timeout: 20000, what: 'the photo taken' })
  assert.ok((await b.call('GET', '/local/profile/photo')).body.equals(one))
})

test('sync: two devices that change the photo at the very same time end on one photo (the greater hash), as does the source', { timeout: 180000 }, async (t) => {
  const s = await source(t)
  const a = await core(t, { deviceName: 'Telefono' })
  const p = await makeProfile(a, 'Bacca')
  await addSource(a, s)
  const b = await core(t, { deviceName: 'PC' })
  assert.equal((await b.call('POST', '/local/profile/import', { code: (await a.get('/local/profile/code')).code })).status, 200)
  await addSource(b, s)

  // A third device whose clock is 4 minutes ahead (the sources take up to 5) set
  // a photo: both devices take it with its time.
  const w = fakeJpeg(7)
  const tw = Date.now() + 4 * 60 * 1000
  assert.equal(s.app.profiles.setPhoto(p.id, w, tw), true)
  for (const h of [a, b]) {
    assert.deepEqual(json(await h.call('POST', '/local/sync')), { ok: true })
    await waitFor(async () => (await h.view()).photo === sha(w), { timeout: 20000, what: 'the photo taken' })
    assert.equal(h.readState().profile.photoUpdatedAt, tw)
  }

  // Within those minutes the phone, then the PC change it: both at tw + 1. The
  // PC's has the greater hash.
  const [y, z] = [fakeJpeg(8), fakeJpeg(9)].sort((m, n) => sha(m) < sha(n) ? -1 : 1)
  await a.put(y)
  await waitFor(() => onSource(s, p.id)[0] === sha(y), { timeout: 20000, what: 'the phone\'s photo on the source' })
  await b.put(z)
  assert.deepEqual([a.readState().profile.photoUpdatedAt, b.readState().profile.photoUpdatedAt], [tw + 1, tw + 1])
  for (let i = 0; i < 2; i++) {
    for (const h of [a, b]) assert.deepEqual(json(await h.call('POST', '/local/sync')), { ok: true })
  }
  await waitFor(async () => (await a.view()).photo === sha(z), { timeout: 20000, what: 'the phone took the PC\'s photo' })
  assert.deepEqual(
    { a: (await a.view()).photo, b: (await b.view()).photo, source: onSource(s, p.id) },
    { a: sha(z), b: sha(z), source: [sha(z), tw + 1] }
  )
  assert.ok((await a.call('GET', '/local/profile/photo')).body.equals(z))
  assert.deepEqual([filesOf(a.dir, y), filesOf(a.dir, z).length], [[], 1])
})

test('sync: a photo time on a source more than 5 minutes ahead could not be real: never taken, never fetched', { timeout: 120000 }, async (t) => {
  const s = await source(t)
  const a = await core(t)
  const p = await makeProfile(a, 'Bacca')
  await addSource(a, s)
  const far = Date.now() + 60 * 60 * 1000
  // Stored there only because the store is told it is that late already.
  assert.equal(s.app.profiles.setPhoto(p.id, fakeJpeg(5), far, far), true)
  const calls = { get: 0, put: 0 }
  const photoFile = s.app.profiles.photoFile.bind(s.app.profiles)
  const setPhoto = s.app.profiles.setPhoto.bind(s.app.profiles)
  s.app.profiles.photoFile = (...args) => {
    calls.get++
    return photoFile(...args)
  }
  s.app.profiles.setPhoto = (...args) => {
    calls.put++
    return setPhoto(...args)
  }
  for (let i = 0; i < 2; i++) assert.deepEqual(json(await a.call('POST', '/local/sync')), { ok: true })
  assert.deepEqual([a.readState().profile.photo, a.readState().profile.photoUpdatedAt, calls], [null, 0, { get: 0, put: 0 }])
  assert.deepEqual(a.photos(), [])
})

test('sync: a photo set here while the source\'s one is on its way wins; the one fetched is never written', { timeout: 120000 }, async (t) => {
  const s = await source(t)
  const a = await core(t, { deviceName: 'Telefono' })
  const p = await makeProfile(a, 'Bacca')
  await addSource(a, s)
  const x = fakeJpeg(11)
  await a.put(x)
  await waitFor(() => onSource(s, p.id)[0] === sha(x), { timeout: 20000, what: 'the photo on the source' })

  // Adding the source waits for its first sync no longer than this: that sync is held.
  const b = await core(t, { deviceName: 'PC', firstSyncWaitMs: 300 })
  assert.equal((await b.call('POST', '/local/profile/import', { code: (await a.get('/local/profile/code')).code })).status, 200)
  const hold = holdPhotoReads(t)
  await addSource(b, s)
  await hold.reached
  const y = fakeJpeg(12)
  await b.put(y)
  hold.release()
  for (let i = 0; i < 2; i++) assert.deepEqual(json(await b.call('POST', '/local/sync')), { ok: true })
  await waitFor(() => onSource(s, p.id)[0] === sha(y), { timeout: 20000, what: 'the PC\'s photo on the source' })
  assert.equal((await b.view()).photo, sha(y))
  assert.ok((await b.call('GET', '/local/profile/photo')).body.equals(y))
  assert.deepEqual([filesOf(b.dir, x), filesOf(b.dir, y).length], [[], 1], 'only the photo set here is on disk')
})

test('sync: stop() while a photo is on its way from a source: it resolves, nothing lands after it, and the next start takes the photo', { timeout: 120000 }, async (t) => {
  const s = await source(t)
  const a = await core(t, { deviceName: 'Telefono' })
  const p = await makeProfile(a, 'Bacca')
  await addSource(a, s)
  const x = fakeJpeg(11)
  await a.put(x)
  await waitFor(() => onSource(s, p.id)[0] === sha(x), { timeout: 20000, what: 'the photo on the source' })

  // Adding the source waits for its first sync no longer than this: that sync is held.
  const b = await core(t, { deviceName: 'PC', firstSyncWaitMs: 300 })
  assert.equal((await b.call('POST', '/local/profile/import', { code: (await a.get('/local/profile/code')).code })).status, 200)
  const hold = holdPhotoReads(t)
  await addSource(b, s)
  await hold.reached
  await b.close()
  hold.release()
  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.deepEqual([b.readState().profile.photo, b.readState().profile.photoUpdatedAt], [null, 0])
  assert.deepEqual(filesOf(b.dir, x), [], 'no file of it')

  const again = await core(t, { statePath: b.statePath, deviceName: 'PC' })
  await waitFor(async () => (await again.view()).photo === sha(x), { timeout: 30000, what: 'the photo taken after the start' })
  assert.equal(again.readState().profile.photoUpdatedAt, a.readState().profile.photoUpdatedAt)
  assert.ok((await again.call('GET', '/local/profile/photo')).body.equals(x))
  assert.equal(filesOf(again.dir, x).length, 1)
})
