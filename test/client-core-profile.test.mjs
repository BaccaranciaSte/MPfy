// Client core with real sources (server/app.mjs) on a local HyperDHT testnet: the
// profile and its endpoints, the sync of names, roles and recovery blobs with
// each source, bringing an identity in (file, code), password recovery on a new
// device and on an upgraded install, and the codes of every /local error.

import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import createTestnet from 'hyperdht/testnet.js'
import { createMPfy } from '../server/app.mjs'
import { createClientCore } from '../client-core/index.js'
import { profileKeys, formatProfileCode, buildIdentity, decryptBlob, pwhashCount } from '../client-core/identity.js'
import { formatCode, generateSecret } from '../transport/code.js'
import { tmpDir, request, json, waitFor, cleanup } from './helpers.mjs'

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web')
const PASSWORD = 'una frase breve'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

/** A real source. claim: its claim window is open (the next new profile becomes its owner). */
async function source (t, { name = 'Fonte', dir = null, claim = false, admitLimits } = {}) {
  const c = cleanup(t)
  const dataDir = dir || c.dir(tmpDir('mpfy-ccp-src-'))
  const app = await createMPfy({
    dataDir, port: 0, adminPort: 0, p2p: true, waitForDht: true, dht: node(), ffmpeg: null, fpcalc: null, sevenZip: null, debounceMs: 10, name, admitLimits
  })
  c.close(app)
  if (claim) app.people.openClaim(30)
  return { app, dir: dataDir, id: app.serverPublicKey.slice(0, 8) }
}

async function core (t, { statePath = null, deviceName = 'Banco di prova', ...opts } = {}) {
  const c = cleanup(t)
  const file = statePath || path.join(c.dir(tmpDir('mpfy-ccp-core-')), 'state.json')
  const events = []
  const instance = createClientCore({ statePath: file, webRoot: WEB, port: 0, deviceName, onEvent: (e) => events.push(e), dht: node(), ...opts })
  const { port } = await instance.start()
  const h = {
    core: instance,
    port,
    statePath: file,
    events,
    close: () => instance.stop(),
    key: () => instance.state().publicKey,
    readState: () => JSON.parse(fs.readFileSync(file, 'utf8')),
    call: (method, p, body, timeout = 90000) => request(port, method, p, { body, timeout }),
    get: async (p) => json(await request(port, 'GET', p, { timeout: 30000 })),
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

async function addSource (h, src, status = 201) {
  const res = await h.call('POST', '/local/sources', { code: src.app.code })
  assert.equal(res.status, status, res.body.toString())
  const entry = json(res).source
  await waitFor(async () => (await h.entry(entry.id))?.connected, { timeout: 30000, what: 'the link to ' + src.id })
  return entry
}

// What the source holds about this device's recovery blob.
function blobOn (src, profileId, key) {
  return src.app.recovery.deviceInfo(profileId, key)
}

function markLegacy (app, key) {
  const list = JSON.parse(fs.readFileSync(app.clients.file, 'utf8'))
  for (const c of list) if (c.publicKey === key) c.legacy = true
  fs.writeFileSync(app.clients.file, JSON.stringify(list, null, 2))
}

const withoutTime = ({ exportedAt, ...rest }) => rest

// ------------------------------------------------------------------ tests

test('profile: bad names refused, create, rename with a newer time, a second create refused; code and export; profile and identity events, none to the page', async (t) => {
  const a = await core(t)
  assert.deepEqual(await a.get('/local/profile'), { profile: null, recovery: false, fileName: null })
  await expectError(a.call('GET', '/local/profile/code'), 404, 'no_profile', 'Nessun profilo')
  await expectError(a.call('GET', '/local/profile/export'), 404, 'no_profile', 'Nessun profilo')
  await expectError(a.call('PATCH', '/local/profile', { name: 'X' }), 404, 'no_profile', 'Nessun profilo')
  await expectError(a.call('PUT', '/local/profile/recovery', { password: PASSWORD }), 404, 'no_profile', 'Nessun profilo')
  for (const bad of ['', '   ', 'x'.repeat(41), '\u{1F3B5}'.repeat(41), 5, null]) {
    await expectError(a.call('POST', '/local/profile', { name: bad }), 400, 'bad_name', 'Nome non valido')
  }
  await expectError(a.call('POST', '/local/profile', {}), 400, 'bad_name')
  assert.deepEqual(a.events.filter((e) => e.type !== 'sources'), [], 'nothing changed yet')
  assert.equal(a.readState().profile, null)

  const t0 = Date.now()
  const p = await makeProfile(a, '  Bacca \u{1F3B5} ')
  assert.deepEqual(Object.keys(p), ['id', 'name', 'nameUpdatedAt', 'photo', 'pid'])
  assert.match(p.pid, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/, 'the profile ID people see')
  assert.equal(p.name, 'Bacca \u{1F3B5}')
  assert.ok(p.nameUpdatedAt >= t0 && p.nameUpdatedAt <= Date.now())
  const st = a.readState()
  assert.match(st.profile.secret, /^[0-9a-f]{64}$/)
  assert.equal(profileKeys(st.profile.secret).id, p.id, 'the id follows from the secret')
  assert.deepEqual(st.profile, { id: p.id, secret: st.profile.secret, name: p.name, nameUpdatedAt: p.nameUpdatedAt, createdAt: st.profile.createdAt, photo: null, photoUpdatedAt: 0 })
  assert.ok(st.profile.createdAt >= t0)
  assert.deepEqual(a.events.filter((e) => e.type === 'profile'), [{ type: 'profile', profile: p }])
  let ids = a.events.filter((e) => e.type === 'identity')
  assert.equal(ids.length, 1)
  assert.equal(ids[0].fileName, 'Bacca \u{1F3B5}.mpfy')
  assert.deepEqual(withoutTime(ids[0].identity), withoutTime(buildIdentity(st)))

  await expectError(a.call('POST', '/local/profile', { name: 'Altro' }), 409, 'profile_exists', 'Profilo gi\u00e0 presente')
  await expectError(a.call('PATCH', '/local/profile', { name: 'x'.repeat(41) }), 400, 'bad_name', 'Nome non valido')
  const renamed = json(await a.call('PATCH', '/local/profile', { name: 'Bacca' })).profile
  assert.equal(renamed.id, p.id)
  assert.equal(renamed.name, 'Bacca')
  assert.ok(renamed.nameUpdatedAt > p.nameUpdatedAt, 'a newer time')
  const same = json(await a.call('PATCH', '/local/profile', { name: 'Bacca' })).profile
  assert.ok(same.nameUpdatedAt > renamed.nameUpdatedAt, 'every rename is newer, the same name too')
  assert.deepEqual(a.events.filter((e) => e.type === 'profile').map((e) => e.profile), [p, renamed, same])
  ids = a.events.filter((e) => e.type === 'identity')
  assert.deepEqual(ids.map((e) => e.fileName), ['Bacca \u{1F3B5}.mpfy', 'Bacca.mpfy', 'Bacca.mpfy'])
  assert.deepEqual(await a.get('/local/profile'), { profile: same, recovery: false, fileName: 'Bacca.mpfy' })

  const secret = a.readState().profile.secret
  assert.deepEqual(await a.get('/local/profile/code'), { code: formatProfileCode(secret) })
  const exported = await a.get('/local/profile/export')
  assert.equal(exported.fileName, 'Bacca.mpfy')
  assert.ok(Number.isInteger(exported.identity.exportedAt) && exported.identity.exportedAt >= t0)
  assert.deepEqual(withoutTime(exported.identity), withoutTime(buildIdentity(a.readState())))
  assert.deepEqual(Object.keys(exported.identity), ['format', 'v', 'profile', 'clientSeed', 'sources', 'recovery', 'exportedAt'])

  // The page reads the secret only where it asks for it on purpose.
  for (const p2 of ['/local/profile', '/local/sources']) assert.ok(!(await a.call('GET', p2)).body.toString().includes(secret), p2)
  assert.equal((await a.call('GET', '/local/events')).status, 404)
  assert.equal((await a.call('GET', '/__native/file/0123456789abcdef')).status, 404, 'never the page for a file of the app')
  assert.equal((await a.call('GET', '/__native')).status, 404)

  // At start the host gets the identity once more (the app writes its file from it).
  await a.close()
  const again = await core(t, { statePath: a.statePath })
  const atStart = again.events.filter((e) => e.type === 'identity')
  assert.equal(atStart.length, 1)
  assert.equal(atStart[0].fileName, 'Bacca.mpfy')
  assert.deepEqual(withoutTime(atStart[0].identity), withoutTime(exported.identity))
  assert.deepEqual(again.events.filter((e) => e.type === 'profile'), [], 'no profile change at start')
})

test('name sync between two devices of one profile: the newest wins, an empty name is never taken; the source\'s own name, role and named', { timeout: 180000 }, async (t) => {
  const s = await source(t, { name: 'Mi A2', claim: true })
  const s2 = await source(t, { name: 'Seconda' })
  const a = await core(t, { deviceName: 'Telefono' })
  const p = await makeProfile(a, 'Bacca')

  // Added after the name was typed: the first sync is in the answer, and the
  // source's fresh record ("" at time 0) gets the local name, never the other way.
  const added = json(await a.call('POST', '/local/sources', { code: s.app.code })).source
  assert.equal(added.id, s.id)
  assert.equal(added.name, 'Mi A2')
  assert.equal(added.role, 'owner', 'claimed inside the window')
  assert.equal(added.named, false)
  assert.equal(added.profiles, true)
  await waitFor(() => s.app.profiles.get(p.id)?.name === 'Bacca', { what: 'the name sent to the source' })
  assert.equal(s.app.profiles.get(p.id).nameUpdatedAt, p.nameUpdatedAt)
  assert.equal(json(await a.call('GET', '/local/profile')).profile.name, 'Bacca')
  const lib = json(await a.call('GET', '/s/' + s.id + '/api/library'))
  assert.deepEqual(lib.you, { profileId: p.id, role: 'owner' }, 'the source knows who is asking through the core')

  // The same person on a second device, by the profile code (no name yet).
  const { code } = await a.get('/local/profile/code')
  const b = await core(t, { deviceName: 'PC' })
  const imported = await b.call('POST', '/local/profile/import', { code: code.toLowerCase().replace(/-/g, ' ') })
  assert.equal(imported.status, 200, imported.body.toString())
  assert.deepEqual(json(imported), { profile: { id: p.id, name: '', nameUpdatedAt: 0, photo: null, pid: p.pid }, sources: [] })

  // First a source that never saw this profile: nothing to take, nothing to send.
  const b2 = await addSource(b, s2)
  assert.equal(b2.role, 'member')
  assert.deepEqual(json(await b.call('POST', '/local/sync')), { ok: true })
  assert.equal(s2.app.profiles.get(p.id).name, '', 'the fresh record there')
  assert.equal((await b.get('/local/profile')).profile.name, '', 'and nothing taken from it')

  // Then the source that knows it: its name and time come back, and go on to the other.
  await addSource(b, s)
  await waitFor(async () => (await b.get('/local/profile')).profile.name === 'Bacca', { what: 'the name taken' })
  assert.equal((await b.get('/local/profile')).profile.nameUpdatedAt, p.nameUpdatedAt, 'with its time')
  await waitFor(() => s2.app.profiles.get(p.id).name === 'Bacca', { what: 'the name passed on' })
  assert.equal((await b.entry(s.id)).role, 'owner', 'the owner\'s profile on another device')

  // A new source and a new principal change the identity: the host hears both.
  const lastIdentity = () => b.events.filter((e) => e.type === 'identity').pop().identity
  assert.deepEqual(lastIdentity().sources.map((x) => [x.id, x.principal]), [[s2.id, true], [s.id, false]])
  assert.equal(lastIdentity().profile.name, 'Bacca')
  assert.equal(json(await b.call('PATCH', '/local/sources/' + s.id, { principal: true })).source.principal, true)
  assert.deepEqual(lastIdentity().sources.map((x) => [x.id, x.principal]), [[s2.id, false], [s.id, true]])

  // A rename on one device reaches the other at its next sync: the newest wins.
  const later = json(await b.call('PATCH', '/local/profile', { name: 'Bacca dal PC' })).profile
  await waitFor(() => s.app.profiles.get(p.id).name === 'Bacca dal PC', { what: 'the rename sent' })
  assert.deepEqual(json(await a.call('POST', '/local/sync')), { ok: true })
  assert.deepEqual((await a.get('/local/profile')).profile, later)
  assert.ok(a.events.some((e) => e.type === 'profile' && e.profile.name === 'Bacca dal PC'))
  // An older time never wins back: the source keeps the newer.
  const newest = json(await a.call('PATCH', '/local/profile', { name: 'Bacca' })).profile
  await waitFor(() => s.app.profiles.get(p.id).name === 'Bacca', { what: 'the newer name sent' })
  await b.call('POST', '/local/sync')
  assert.deepEqual((await b.get('/local/profile')).profile, newest)
  assert.equal(s.app.profiles.get(p.id).nameUpdatedAt, newest.nameUpdatedAt)

  // The source's own name: the owner renames it, every device follows at its next sync.
  const rn = await a.call('PATCH', '/s/' + s.id + '/api/admin/source', { name: 'Casa' })
  assert.equal(rn.status, 200, rn.body.toString())
  await a.call('POST', '/local/sync')
  assert.deepEqual(await a.entry(s.id).then((e) => [e.name, e.role, e.named]), ['Casa', 'owner', true])
  assert.ok(a.events.some((e) => e.type === 'sources' && e.sources.some((x) => x.id === s.id && x.name === 'Casa' && x.named === true)), 'announced')
  await b.call('POST', '/local/sync')
  assert.deepEqual(await b.entry(s.id).then((e) => [e.name, e.named]), ['Casa', true])
  assert.equal(b.readState().sources.find((x) => x.id === s.id).name, 'Casa')
  // No local names.
  await expectError(a.call('PATCH', '/local/sources/' + s.id, { name: 'Mia' }), 400, 'bad_request', 'Richiesta non valida')
  assert.equal((await a.entry(s.id)).name, 'Casa')
})

test('profiles: a source with profiles says true in the answer that adds it, with a profile and without one, in the same change that sets its role; an identity brought in leaves it unknown until the source answers again', { timeout: 180000 }, async (t) => {
  const s = await source(t, { name: 'Mi A2', claim: true })
  const fields = (x) => [x.profiles, x.role, x.named]
  // In every list the host heard, profiles true only ever came with a role.
  const together = (h) => {
    for (const e of h.events.filter((x) => x.type === 'sources')) {
      for (const x of e.sources) assert.equal(x.profiles === true, x.role !== null, 'profiles and role move together: ' + JSON.stringify(fields(x)))
    }
  }

  const a = await core(t, { deviceName: 'Telefono' })
  await makeProfile(a, 'Bacca')
  const res = await a.call('POST', '/local/sources', { code: s.app.code })
  assert.equal(res.status, 201, res.body.toString())
  assert.deepEqual(fields(json(res).source), [true, 'owner', false])
  assert.deepEqual(fields(a.readState().sources[0]), [true, 'owner', false])
  assert.equal(a.core.state().sources[0].profiles, true)
  assert.ok(a.events.some((e) => e.type === 'sources' && e.sources.some((x) => x.profiles === null)), 'unknown first')
  together(a)

  // A device without a profile is a guest there, and the source still has profiles.
  const g = await core(t, { deviceName: 'Ospite' })
  const guest = await addSource(g, s)
  assert.deepEqual(fields(guest), [true, 'guest', false])
  together(g)

  // An identity file that also carries what a state holds about its sources (made
  // by hand): what the sources said is unknown again until they answer.
  const file = (await a.get('/local/profile/export')).identity
  await a.close()
  file.sources = file.sources.map((x) => ({ ...x, role: 'owner', named: true, profiles: true }))
  const b = await core(t, { deviceName: 'PC' })
  const imported = await b.call('POST', '/local/profile/import', { identity: file })
  assert.equal(imported.status, 200, imported.body.toString())
  assert.deepEqual(json(imported).sources.map(fields), [[null, null, null]])
  const first = b.events.find((e) => e.type === 'sources' && e.sources.length === 1)
  assert.deepEqual(first.sources.map(fields), [[null, null, null]], 'and so the host hears it')
  await waitFor(async () => (await b.entry(s.id))?.profiles === true, { timeout: 30000, what: 'the source answering' })
  assert.deepEqual(fields(await b.entry(s.id)), [true, 'owner', false])
  assert.deepEqual(fields(b.readState().sources[0]), [true, 'owner', false])
  together(b)
})

test('import: an identity file (the device key it replaces is forgotten on every source first), a profile code; refused once a profile exists; bad files and codes named', { timeout: 180000 }, async (t) => {
  const s = await source(t, { name: 'Mi A2', claim: true })
  const a = await core(t, { deviceName: 'Telefono' })
  const p = await makeProfile(a, 'Bacca')
  await addSource(a, s)
  const exported = await a.get('/local/profile/export')
  const aKey = a.key()
  await a.close() // the old phone is gone

  // A fresh install that already paired with that source, without a profile: a guest there.
  const c = await core(t, { deviceName: 'Nuovo' })
  const guest = await addSource(c, s)
  assert.equal(guest.role, 'guest')
  const cKey = c.key()
  assert.ok(s.app.clients.has(cKey))
  const file = exported.identity
  for (const [bad, what] of [
    [{ ...file, format: 'altro' }, 'format'],
    [{ ...file, v: 2 }, 'version'],
    [{ ...file, profile: { ...file.profile, id: '0'.repeat(32) } }, 'an id that is not the secret\'s'],
    [{ ...file, clientSeed: 'zz' }, 'seed'],
    [{ ...file, sources: 'no' }, 'sources'],
    ['{"format":', 'not JSON'],
    [[file], 'a list']
  ]) {
    await expectError(c.call('POST', '/local/profile/import', { identity: bad }), 400, 'bad_file', 'File non valido')
    assert.ok(s.app.clients.has(cKey), 'nothing forgotten for a bad file: ' + what)
  }

  // The file as the text the app read: this device becomes the old phone.
  const res = await c.call('POST', '/local/profile/import', { identity: JSON.stringify(file, null, 2) + '\n' })
  assert.equal(res.status, 200, res.body.toString())
  const body = json(res)
  assert.deepEqual(body.profile, { id: p.id, name: 'Bacca', nameUpdatedAt: p.nameUpdatedAt, photo: null, pid: p.pid })
  assert.deepEqual(body.sources.map((x) => [x.id, x.name, x.principal, x.role, x.named, x.profiles]), [[s.id, 'Mi A2', true, null, null, null]])
  assert.equal(s.app.clients.has(cKey), false, 'the key it had is forgotten there first')
  assert.equal(c.key(), aKey, 'it is the old phone\'s key now')
  const st = c.readState()
  assert.equal(st.clientSeed, file.clientSeed)
  assert.equal(st.profile.secret, file.profile.secret)
  assert.equal(st.recovery, null)
  assert.deepEqual(st.recoveryDeletes, [])
  await waitFor(async () => (await c.entry(s.id))?.role === 'owner', { timeout: 30000, what: 'the new link synced' })
  assert.ok(c.events.some((e) => e.type === 'profile' && e.profile.id === p.id))
  assert.equal(c.events.filter((e) => e.type === 'identity').pop().identity.clientSeed, file.clientSeed)

  await expectError(c.call('POST', '/local/profile/import', { identity: file }), 409, 'profile_exists', 'Profilo gi\u00e0 presente')
  await expectError(c.call('POST', '/local/profile/import', { code: formatProfileCode(file.profile.secret) }), 409, 'profile_exists')

  // By code, on yet another device: the profile only, its own key and sources kept.
  const d = await core(t)
  const dKey = d.key()
  await expectError(d.call('POST', '/local/profile/import', { code: s.app.code }), 400, 'source_code', 'Questo \u00e8 il codice di una fonte')
  await expectError(d.call('POST', '/local/profile/import', { code: 'MPFY-P-1234' }), 400, 'bad_code', 'Codice non valido')
  const good = formatProfileCode(file.profile.secret)
  await expectError(d.call('POST', '/local/profile/import', { code: good.slice(0, -1) + (good.endsWith('0') ? '1' : '0') }), 400, 'bad_code', 'Codice non valido')
  await expectError(d.call('POST', '/local/profile/import', { code: 7 }), 400, 'bad_code')
  await expectError(d.call('POST', '/local/profile/import', {}), 400, 'bad_request', 'Richiesta non valida')
  const byCode = json(await d.call('POST', '/local/profile/import', { code: good }))
  assert.deepEqual(byCode, { profile: { id: p.id, name: '', nameUpdatedAt: 0, photo: null, pid: p.pid }, sources: [] })
  assert.equal(d.key(), dKey)
  assert.equal(d.readState().profile.secret, file.profile.secret)
})

test('password recovery: on, every source gets this device\'s blob; a new source gets it and the others a fresh one; a source away catches up when back, for a new password and for off', { timeout: 300000 }, async (t) => {
  const s1 = await source(t, { name: 'Uno' })
  const s2dir = cleanup(t).dir(tmpDir('mpfy-ccp-src-'))
  let s2 = await source(t, { name: 'Due', dir: s2dir })
  const s3 = await source(t, { name: 'Tre' })
  const a = await core(t, { deviceName: 'Telefono' })
  const p = await makeProfile(a, 'Bacca')
  await addSource(a, s1)
  await addSource(a, s2)
  const key = a.key()

  await expectError(a.call('PUT', '/local/profile/recovery', { password: 'corta' }), 400, 'short_password', 'Almeno 8 caratteri')
  await expectError(a.call('PUT', '/local/profile/recovery', { password: '\u{1F3B5}'.repeat(7) }), 400, 'short_password')
  await expectError(a.call('PUT', '/local/profile/recovery', {}), 400, 'short_password')
  assert.equal(a.readState().recovery, null)

  const t0 = Date.now()
  const on = json(await a.call('PUT', '/local/profile/recovery', { password: PASSWORD }))
  assert.deepEqual(on, { recovery: true, sources: { [s1.id]: 'ok', [s2.id]: 'ok' } })
  let st = a.readState()
  assert.deepEqual(Object.keys(st.recovery), ['salt', 'opslimit', 'memlimit', 'encKey', 'verifierHash', 'updatedAt'])
  assert.equal(st.recovery.opslimit, 3)
  assert.equal(st.recovery.memlimit, 67108864)
  assert.ok(st.recovery.updatedAt >= t0)
  assert.ok(!fs.readFileSync(a.statePath, 'utf8').includes(PASSWORD), 'never the password')
  assert.equal((await a.get('/local/profile')).recovery, true)
  for (const s of [s1, s2]) assert.deepEqual(blobOn(s, p.id, key), { updatedAt: st.recovery.updatedAt }, s.id)
  // On the source: the parameters, the verifier hash and a blob only this key opens:
  // this identity without its recovery key.
  const rec = JSON.parse(fs.readFileSync(path.join(s1.dir, 'recovery', p.id + '.json'), 'utf8')).devices[key]
  assert.deepEqual([rec.salt, rec.opslimit, rec.memlimit, rec.verifierHash, rec.deviceName], [st.recovery.salt, 3, 67108864, st.recovery.verifierHash, 'Telefono'])
  assert.ok(!JSON.stringify(rec).includes(st.recovery.encKey), 'the key stays on the device')
  const inside = JSON.parse(decryptBlob(rec.blob, Buffer.from(st.recovery.encKey, 'hex'), p.id))
  assert.equal(inside.recovery, null)
  assert.deepEqual(withoutTime(inside), withoutTime(buildIdentity(st, { withRecovery: false })))
  const fileEvent = a.events.filter((e) => e.type === 'identity').pop()
  assert.deepEqual(fileEvent.identity.recovery, st.recovery, 'the file keeps the recovery key')

  // A new source: it gets the blob, and the others a fresh one (the identity changed).
  const first = st.recovery.updatedAt
  await addSource(a, s3)
  await waitFor(() => {
    const now = a.readState().recovery.updatedAt
    return now > first && [s1, s2, s3].every((s) => blobOn(s, p.id, key)?.updatedAt === now)
  }, { timeout: 30000, what: 'a fresh blob everywhere' })
  st = a.readState()
  const listed = JSON.parse(decryptBlob(JSON.parse(fs.readFileSync(path.join(s1.dir, 'recovery', p.id + '.json'), 'utf8')).devices[key].blob, Buffer.from(st.recovery.encKey, 'hex'), p.id))
  assert.deepEqual(listed.sources.map((x) => x.id), [s1.id, s2.id, s3.id])

  // s2 goes away; a new password: ok where the source answered, pending there.
  await s2.app.close()
  await waitFor(async () => (await a.entry(s2.id)).connected === false, { what: 's2 down' })
  const changed = json(await a.call('PUT', '/local/profile/recovery', { password: 'un\'altra frase' }))
  assert.deepEqual(changed.sources, { [s1.id]: 'ok', [s2.id]: 'pending', [s3.id]: 'ok' })
  st = a.readState()
  assert.notEqual(blobOn(s1, p.id, key).updatedAt, first)
  s2 = await source(t, { name: 'Due', dir: s2dir })
  a.core.refresh()
  await waitFor(() => blobOn(s2, p.id, key)?.updatedAt === a.readState().recovery.updatedAt, { timeout: 90000, interval: 200, what: 's2 caught up' })

  // Off while s2 is away: gone at once where the source answers, from s2 once back.
  await s2.app.close()
  await waitFor(async () => (await a.entry(s2.id)).connected === false, { what: 's2 down again' })
  assert.deepEqual(json(await a.call('DELETE', '/local/profile/recovery')), { recovery: false })
  assert.equal(a.readState().recovery, null)
  assert.equal((await a.get('/local/profile')).recovery, false)
  await waitFor(() => blobOn(s1, p.id, key) === null && blobOn(s3, p.id, key) === null, { timeout: 30000, what: 'deleted where reachable' })
  await waitFor(() => JSON.stringify(a.readState().recoveryDeletes) === JSON.stringify([s2.id]), { what: 'only s2 left to do' })
  s2 = await source(t, { name: 'Due', dir: s2dir })
  assert.notEqual(blobOn(s2, p.id, key), null, 'still there while it was away')
  a.core.refresh()
  await waitFor(() => blobOn(s2, p.id, key) === null, { timeout: 90000, interval: 200, what: 's2 deleted it' })
  await waitFor(() => a.readState().recoveryDeletes.length === 0, { what: 'nothing left to do' })
  assert.equal(fileEvent.identity.recovery !== null, true)
  assert.equal(a.events.filter((e) => e.type === 'identity').pop().identity.recovery, null, 'the file says it is off')
})

test('recovery on a new device: codes checked, a cancel forgets the device, wrong password, unknown parameters never reach Argon2id, success replaces the state and the temporary key goes; the lock', { timeout: 240000 }, async (t) => {
  const s = await source(t, { name: 'Mi A2', claim: true })
  const a = await core(t, { deviceName: 'Telefono' })
  const p = await makeProfile(a, 'Bacca')
  await addSource(a, s)
  assert.equal(json(await a.call('PUT', '/local/profile/recovery', { password: PASSWORD })).sources[s.id], 'ok')
  const aKey = a.key()
  const aState = a.readState()
  await expectError(a.call('POST', '/local/recovery', { code: s.app.code }), 409, 'profile_exists', 'Profilo gi\u00e0 presente')

  const n = await core(t, { deviceName: 'Nuovo telefono' })
  await expectError(n.call('POST', '/local/recovery', { code: formatProfileCode(aState.profile.secret) }), 400, 'profile_code', 'Questo \u00e8 il codice del profilo')
  await expectError(n.call('POST', '/local/recovery', { code: 'MPFY-12' }), 400, 'bad_code', 'Codice non valido')
  await expectError(n.call('POST', '/local/recovery', {}), 400, 'bad_code')
  const started = json(await n.call('POST', '/local/recovery', { code: s.app.code }))
  assert.match(started.sessionId, /^[0-9a-f]{16}$/)
  assert.deepEqual(started.source, { name: 'Mi A2' })
  assert.deepEqual(started.entries, [{ profileId: p.id, name: 'Bacca', device: aKey, deviceName: 'Telefono' }])
  const nKey = n.key()
  assert.ok(s.app.clients.has(nKey), 'admitted for now')
  assert.ok(!s.app.clients.get(nKey).profileId, 'without a profile: a guest')
  assert.deepEqual((await n.get('/local/sources')).sources, [], 'the temporary link is no source')
  assert.equal(n.readState().profile, null)

  // Cancelled: the source forgets this device, the session is gone.
  assert.deepEqual(json(await n.call('DELETE', '/local/recovery/' + started.sessionId)), { ok: true })
  assert.equal(s.app.clients.has(nKey), false)
  const body = (password, more = {}) => ({ profileId: p.id, device: aKey, password, ...more })
  await expectError(n.call('POST', '/local/recovery/' + started.sessionId, body(PASSWORD)), 404, 'session_gone', 'Sessione scaduta')
  await expectError(n.call('POST', '/local/recovery/nope', body(PASSWORD)), 404, 'session_gone')
  assert.deepEqual(json(await n.call('DELETE', '/local/recovery/' + started.sessionId)), { ok: true }, 'twice is fine')

  const sid = json(await n.call('POST', '/local/recovery', { code: s.app.code })).sessionId
  const wrong = await expectError(n.call('POST', '/local/recovery/' + sid, body('sbagliata!')), 403, 'wrong_password', 'Password errata')
  assert.equal(wrong.triesLeft, 4)
  await expectError(n.call('POST', '/local/recovery/' + sid, body(PASSWORD, { device: 'ab'.repeat(32) })), 404, 'no_recovery', 'Recupero non attivo')
  await expectError(n.call('POST', '/local/recovery/' + sid, body(PASSWORD, { profileId: 'xyz' })), 400, 'bad_request')
  await expectError(n.call('POST', '/local/recovery/' + sid, { profileId: p.id, device: aKey }), 400, 'bad_request')

  // Parameters this core does not know are refused before Argon2id runs.
  const dev = s.app.recovery._records.get(p.id).devices[aKey]
  for (const [field, value] of [['opslimit', 4], ['memlimit', 33554432]]) {
    const was = dev[field]
    dev[field] = value
    const runs = pwhashCount()
    await expectError(n.call('POST', '/local/recovery/' + sid, body(PASSWORD)), 404, 'no_recovery', 'Recupero non attivo')
    assert.equal(pwhashCount(), runs, 'Argon2id never ran with ' + field + ' ' + value)
    dev[field] = was
  }
  assert.equal(s.app.recovery._records.get(p.id).failures.length, 1, 'and nothing was tried on the source')

  // The right password: this device becomes the phone that made the blob.
  const done = json(await n.call('POST', '/local/recovery/' + sid, body(PASSWORD)))
  assert.deepEqual(done.profile, { id: p.id, name: 'Bacca', nameUpdatedAt: aState.profile.nameUpdatedAt, photo: null, pid: p.pid })
  assert.deepEqual(done.sources.map((x) => [x.id, x.principal]), [[s.id, true]])
  const ns = n.readState()
  assert.equal(ns.clientSeed, aState.clientSeed)
  assert.equal(ns.profile.secret, aState.profile.secret)
  assert.deepEqual(ns.sources.map((x) => [x.id, x.serverPublicKey]), aState.sources.map((x) => [x.id, x.serverPublicKey]))
  assert.deepEqual(ns.recovery, aState.recovery, 'the same password stays on')
  assert.equal(n.key(), aKey)
  assert.equal(s.app.clients.has(nKey), false, 'the temporary key is gone from the source')
  await expectError(n.call('POST', '/local/recovery/' + sid, body(PASSWORD)), 404, 'session_gone')
  assert.deepEqual(n.events.filter((e) => e.type === 'profile').map((e) => e.profile), [done.profile])
  assert.equal(n.events.filter((e) => e.type === 'identity').pop().identity.profile.secret, aState.profile.secret)
  await waitFor(async () => (await n.entry(s.id))?.role === 'owner', { timeout: 30000, what: 'back on the source as the old phone' })

  // The lock: 5 failures within the hour (the one above counts), and then even the
  // right password waits. The session stays open meanwhile.
  const n2 = await core(t, { deviceName: 'Tablet' })
  const sid2 = json(await n2.call('POST', '/local/recovery', { code: s.app.code })).sessionId
  for (let left = 3; left >= 1; left--) {
    assert.equal((await expectError(n2.call('POST', '/local/recovery/' + sid2, body('sbagliata!')), 403, 'wrong_password')).triesLeft, left)
  }
  const locked = await expectError(n2.call('POST', '/local/recovery/' + sid2, body('sbagliata!')), 429, 'locked', 'Troppi tentativi')
  assert.ok(locked.retryAt > Date.now() + 50 * 60000, 'about an hour')
  const still = await expectError(n2.call('POST', '/local/recovery/' + sid2, body(PASSWORD)), 429, 'locked')
  assert.equal(still.retryAt, locked.retryAt)
  const n2Key = n2.key()
  assert.ok(s.app.clients.has(n2Key))
  assert.deepEqual(json(await n2.call('DELETE', '/local/recovery/' + sid2)), { ok: true })
  assert.equal(s.app.clients.has(n2Key), false)
  assert.equal(n2.readState().profile, null)
})

test('an upgraded install recovering with the code of a source it already had: a cancel keeps its admission there, a success forgets its old key there too', { timeout: 180000 }, async (t) => {
  const s = await source(t, { name: 'Mi A2' })
  const a = await core(t, { deviceName: 'Telefono' })
  const p = await makeProfile(a, 'Bacca')
  await addSource(a, s)
  await a.call('PUT', '/local/profile/recovery', { password: PASSWORD })
  const aKey = a.key()

  // An install from before profiles: its key was admitted then (legacy) and acts as the owner.
  const u = await core(t, { deviceName: 'Vecchio telefono' })
  await addSource(u, s)
  const uKey = u.key()
  markLegacy(s.app, uKey)
  await u.call('POST', '/local/sync')
  assert.equal((await u.entry(s.id)).role, 'owner')

  const first = json(await u.call('POST', '/local/recovery', { code: s.app.code }))
  assert.deepEqual(first.entries.map((e) => [e.profileId, e.device]), [[p.id, aKey]])
  assert.deepEqual(json(await u.call('DELETE', '/local/recovery/' + first.sessionId)), { ok: true })
  assert.ok(s.app.clients.has(uKey), 'still admitted: the device keeps using that key')
  assert.equal(s.app.clients.get(uKey).legacy, true)
  assert.equal((await u.entry(s.id)).connected, true, 'and its link stays up')

  const sid = json(await u.call('POST', '/local/recovery', { code: s.app.code })).sessionId
  const done = json(await u.call('POST', '/local/recovery/' + sid, { profileId: p.id, device: aKey, password: PASSWORD }))
  assert.equal(done.profile.id, p.id)
  assert.equal(s.app.clients.has(uKey), false, 'the old key is gone from that source too')
  assert.equal(u.key(), aKey)
  assert.deepEqual(u.readState().sources.map((x) => x.id), [s.id])
})

test('a recovery session left open: the same source added meanwhile keeps this device at the cancel and at the expiry; a profile made meanwhile ends the session', { timeout: 180000 }, async (t) => {
  const s = await source(t, { name: 'Mi A2', claim: true })
  // Through the core: answered only while the source still admits this device.
  const reach = (h) => h.call('GET', '/s/' + s.id + '/api/health')

  // Cancelled after the source became one of this device's sources: it stays.
  const u = await core(t, { deviceName: 'Telefono' })
  const first = json(await u.call('POST', '/local/recovery', { code: s.app.code }))
  const uKey = u.key()
  assert.ok(s.app.clients.has(uKey))
  await addSource(u, s)
  assert.deepEqual(json(await u.call('DELETE', '/local/recovery/' + first.sessionId)), { ok: true })
  assert.ok(s.app.clients.has(uKey), 'still admitted at the cancel')
  assert.equal((await reach(u)).status, 200)

  // Expired after the same: it stays too.
  const w = await core(t, { deviceName: 'Tablet', recoverySessionMs: 6000 })
  json(await w.call('POST', '/local/recovery', { code: s.app.code }))
  const opened = Date.now()
  const wKey = w.key()
  await addSource(w, s)
  assert.ok(Date.now() < opened + 5000, 'added well before the session ends')
  await sleep(opened + 7500 - Date.now())
  assert.ok(s.app.clients.has(wKey), 'still admitted at the expiry')
  assert.equal((await reach(w)).status, 200)

  // A profile made while a session is open (the page reloaded, the person started
  // over): the session can no longer end in a recovery, so it ends there, with its
  // admission. The same source added afterwards stays, past the session's time.
  const v = await core(t, { deviceName: 'PC', recoverySessionMs: 2500 })
  const sid = json(await v.call('POST', '/local/recovery', { code: s.app.code })).sessionId
  const vKey = v.key()
  assert.ok(s.app.clients.has(vKey))
  const p = await makeProfile(v, 'Bacca')
  assert.equal(s.app.clients.has(vKey), false, 'the guest admission went with the session')
  await expectError(v.call('POST', '/local/recovery/' + sid, { profileId: p.id, device: vKey, password: PASSWORD }), 404, 'session_gone')
  const added = await addSource(v, s)
  assert.equal(added.role, 'owner', 'claimed inside the window')
  await sleep(4000)
  assert.equal(s.app.clients.get(vKey)?.profileId, p.id, 'still admitted, bound to the profile')
  assert.equal((await reach(v)).status, 200)

  // The same when the profile comes in by its code or by its file.
  const byCode = { code: (await v.get('/local/profile/code')).code }
  const byFile = { identity: (await v.get('/local/profile/export')).identity }
  for (const [what, body] of [['code', byCode], ['file', byFile]]) {
    const x = await core(t, { deviceName: 'Altro' })
    const xSid = json(await x.call('POST', '/local/recovery', { code: s.app.code })).sessionId
    const xKey = x.key()
    assert.ok(s.app.clients.has(xKey))
    assert.equal((await x.call('POST', '/local/profile/import', body)).status, 200, what)
    assert.equal(s.app.clients.has(xKey), false, 'the guest admission went: ' + what)
    await expectError(x.call('POST', '/local/recovery/' + xSid, { profileId: p.id, device: vKey, password: PASSWORD }), 404, 'session_gone')
    await x.close()
  }
})

test('times a source gives back are taken only when they could be real: a name from the future is not adopted, a recovery time it makes up moves nothing; every other source keeps getting each change', { timeout: 240000 }, async (t) => {
  const good = await source(t, { name: 'Buona' })
  const bad = await source(t, { name: 'Cattiva' })
  const a = await core(t, { deviceName: 'Telefono' })
  const p = await makeProfile(a, 'Bacca')
  await addSource(a, good)
  await addSource(a, bad)
  const key = a.key()
  const sane = (time) => Number.isSafeInteger(time) && time <= Date.now()
  const blobName = (s) => {
    const rec = JSON.parse(fs.readFileSync(path.join(s.dir, 'recovery', p.id + '.json'), 'utf8')).devices[key]
    return JSON.parse(decryptBlob(rec.blob, Buffer.from(a.readState().recovery.encKey, 'hex'), p.id)).profile.name
  }

  // The bad source stores what it gets but answers every upload with a time of its own.
  let answer = 2 ** 53
  const put = bad.app.recovery.put.bind(bad.app.recovery)
  bad.app.recovery.put = (...args) => {
    put(...args)
    return answer
  }
  const on = json(await a.call('PUT', '/local/profile/recovery', { password: PASSWORD }))
  assert.ok(sane(a.readState().recovery.updatedAt), 'the time stays this device\'s own')
  assert.equal(on.sources[good.id], 'ok')
  await waitFor(() => blobOn(good, p.id, key)?.updatedAt === a.readState().recovery.updatedAt, { what: 'the blob on the good source' })
  // A rename is a change of the identity: a newer blob reaches the good source.
  const before = a.readState().recovery.updatedAt
  json(await a.call('PATCH', '/local/profile', { name: 'Bacca 2' }))
  await a.call('POST', '/local/sync')
  await waitFor(() => blobOn(good, p.id, key)?.updatedAt === a.readState().recovery.updatedAt, { what: 'the newer blob on the good source' })
  assert.ok(a.readState().recovery.updatedAt > before)
  assert.equal(blobName(good), 'Bacca 2')

  // A plausible time a little ahead: still nothing moves here.
  answer = Date.now() + 60000
  json(await a.call('PATCH', '/local/profile', { name: 'Bacca 3' }))
  await a.call('POST', '/local/sync')
  await a.call('POST', '/local/sync')
  assert.ok(sane(a.readState().recovery.updatedAt), 'not moved to the source\'s time')
  await waitFor(() => blobOn(good, p.id, key)?.updatedAt === a.readState().recovery.updatedAt, { what: 'the blob after the second rename' })
  assert.equal(blobName(good), 'Bacca 3')

  // A name a year ahead: never adopted, and the next rename still reaches the others.
  const year = 365 * 24 * 3600 * 1000
  assert.ok(bad.app.profiles.setName(p.id, 'Intruso', Date.now() + year, Date.now() + 2 * year))
  await a.call('POST', '/local/sync')
  assert.equal((await a.get('/local/profile')).profile.name, 'Bacca 3', 'the name from the future is not taken')
  assert.ok(sane(a.readState().profile.nameUpdatedAt))
  const renamed = json(await a.call('PATCH', '/local/profile', { name: 'Bacca 4' })).profile
  await waitFor(() => good.app.profiles.get(p.id).name === 'Bacca 4', { what: 'the rename on the good source' })
  assert.equal(good.app.profiles.get(p.id).nameUpdatedAt, renamed.nameUpdatedAt)

  // Recovering from a source that gives the blob a time of its own: this device's
  // time instead. The phone that made the blob is gone meanwhile.
  await a.close()
  const release = good.app.recovery.release.bind(good.app.recovery)
  good.app.recovery.release = (...args) => {
    const r = release(...args)
    return r.ok ? { ...r, updatedAt: 2 ** 53 } : r
  }
  const n = await core(t, { deviceName: 'Nuovo' })
  const sid = json(await n.call('POST', '/local/recovery', { code: good.app.code })).sessionId
  const t0 = Date.now()
  const done = json(await n.call('POST', '/local/recovery/' + sid, { profileId: p.id, device: key, password: PASSWORD }))
  assert.equal(done.profile.id, p.id)
  const got = n.readState().recovery.updatedAt
  assert.ok(sane(got) && got >= t0, 'a time of its own: ' + got)
})

test('an identity brought back with recovery off: the blobs this device left on its sources are deleted', { timeout: 180000 }, async (t) => {
  const s = await source(t, { name: 'Mi A2' })
  const a = await core(t, { deviceName: 'Telefono' })
  const p = await makeProfile(a, 'Bacca')
  await addSource(a, s)
  const old = (await a.get('/local/profile/export')).identity
  assert.equal(old.recovery, null)
  await a.call('PUT', '/local/profile/recovery', { password: PASSWORD })
  const key = a.key()
  assert.notEqual(blobOn(s, p.id, key), null)
  await a.close() // the state is lost; the old file is all there is

  const c = await core(t, { deviceName: 'Telefono' })
  assert.equal((await c.call('POST', '/local/profile/import', { identity: old })).status, 200)
  assert.equal(c.key(), key)
  await waitFor(async () => (await c.entry(s.id))?.connected, { timeout: 30000, what: 'the link with the old key' })
  assert.deepEqual(json(await c.call('POST', '/local/sync')), { ok: true })
  assert.equal(blobOn(s, p.id, key), null, 'recovery is off here: no blob of this device stays there')
  assert.equal((await c.get('/local/profile')).recovery, false)
  assert.deepEqual(c.readState().recoveryDeletes, [])

  // Turned on again: a new blob, kept at every sync.
  assert.equal(json(await c.call('PUT', '/local/profile/recovery', { password: PASSWORD })).sources[s.id], 'ok')
  await c.call('POST', '/local/sync')
  assert.equal(blobOn(s, p.id, key).updatedAt, c.readState().recovery.updatedAt)
})

test('errors: refused and unreachable sources, a source gone during recovery, an expired session; each with its code', { timeout: 180000 }, async (t) => {
  // No pairing at all this hour: every new key is refused.
  const closed = await source(t, { name: 'Chiusa', admitLimits: { perHour: 0 } })
  const c = await core(t, { pairTimeoutMs: 6000, recoveryRequestMs: 4000, recoverySessionMs: 2500 })
  await expectError(c.call('POST', '/local/sources', { code: closed.app.code }), 403, 'refused', 'Abbinamento rifiutato')
  await expectError(c.call('POST', '/local/recovery', { code: closed.app.code }), 403, 'refused', 'Abbinamento rifiutato')
  const nowhere = formatCode(generateSecret())
  await expectError(c.call('POST', '/local/sources', { code: nowhere }), 504, 'unreachable', 'Fonte non raggiungibile')
  await expectError(c.call('POST', '/local/recovery', { code: nowhere }), 504, 'unreachable', 'Fonte non raggiungibile')

  // Nobody to recover there: an empty list (the page says so).
  const s = await source(t, { name: 'Va via' })
  const sid = json(await c.call('POST', '/local/recovery', { code: s.app.code }))
  assert.deepEqual(sid.entries, [])
  const cKey = c.key()
  // The source goes away: unreachable, and the session is still there for another try.
  await s.app.close()
  await expectError(c.call('POST', '/local/recovery/' + sid.sessionId, { profileId: '0'.repeat(32), device: '1'.repeat(64), password: PASSWORD }), 504, 'unreachable', 'Fonte non raggiungibile')
  // ... until it expires.
  await new Promise((resolve) => setTimeout(resolve, 2600))
  await expectError(c.call('POST', '/local/recovery/' + sid.sessionId, { profileId: '0'.repeat(32), device: '1'.repeat(64), password: PASSWORD }), 404, 'session_gone', 'Sessione scaduta')

  // An expired session forgets the device on its source.
  const s2 = await source(t, { name: 'Resta' })
  await c.call('POST', '/local/recovery', { code: s2.app.code })
  assert.ok(s2.app.clients.has(cKey))
  await waitFor(() => !s2.app.clients.has(cKey), { timeout: 10000, what: 'forgotten at expiry' })

  // Methods and unknown paths.
  await expectError(c.call('GET', '/local/sync'), 405, 'method_not_allowed', 'Metodo non consentito')
  await expectError(c.call('GET', '/local/profile/recovery'), 405, 'method_not_allowed')
  await expectError(c.call('GET', '/local/nothing'), 404, 'not_found')
  await expectError(c.call('POST', '/local/profile', '{x'), 400, 'bad_request', 'Richiesta non valida')
})
