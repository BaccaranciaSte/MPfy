// Who is asking: the profile proof, the binding of a device key, the roles
// (owner, member, guest, local), the owner claim and its window, set-owner and
// remove-profile (running server and CLI with the server stopped), no cap on
// devices or profiles, the hourly limit on pairings, and names. Requests "from a device" come from
// 127.0.0.2 with a test header standing in for the transport's port mapping
// (testWhoIs); one test goes through the real transport on a local testnet.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import createTestnet from 'hyperdht/testnet.js'
import { createMPfy, AdmissionLimiter } from '../server/app.mjs'
import { checkProof, profileIdOf } from '../server/proof.mjs'
import { runCommand } from '../server/index.mjs'
import { MPfyLink, pair, generateKeyPair } from '../transport/client.js'
import {
  tmpDir, cleanup, request, json, waitFor, makeWav, makeProfile, proofHeaders, device, deviceKey, testWhoIs, fakeTool, makeZip
} from './helpers.mjs'

const VECTOR_PROOF = 'e4abea2357415e195ded1df44e7a5cb392eb9322970e2598bee865e921ca877eb048c7c1fa3c68cf365c779291890bc3a960804a1f548b6927a5246a3c4f30ad70059762bbc2531bef26a54dced6030f88fe56f3bc27920956bbe2abf2ebe001'
const body = (r) => json(r)

async function start (t, opts = {}) {
  const c = cleanup(t)
  const dir = opts.dir || c.dir(tmpDir())
  const app = c.close(await createMPfy({
    dataDir: dir, port: 0, adminPort: 0, p2p: false, debounceMs: 10, ffmpeg: null, fpcalc: null, sevenZip: null, whoIs: testWhoIs, ...opts
  }))
  return { app, dir, port: app.ports.http }
}

const readJson = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))

// A data dir from before profiles: db.json schema 2 with the owner's data, and admitted keys.
function olderDir (dir, { keys = [], tracks = [], playlists = [], likes = [], recents = [], covers = {} } = {}) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({
    schema: 2, version: 9, tracks, playlists, likes, recents, covers: { track: {}, album: {}, playlist: {}, ...covers }
  }))
  fs.writeFileSync(path.join(dir, 'clients.json'), JSON.stringify(keys.map((k, i) => ({ publicKey: k, name: 'Vecchio ' + i, addedAt: 1000 + i }))))
}

test('proof: the vector verifies; a valid proof binds the key; a proof made for another key or another source is bad_profile', async (t) => {
  const vector = makeProfile(Buffer.from([...Array(32).keys()]))
  assert.equal(vector.id, '22de25661c578b57b919dfcada067bd4')
  assert.equal(vector.signPublicKey.toString('hex'), 'e4abea2357415e195ded1df44e7a5cb392eb9322970e2598bee865e921ca877e')
  assert.equal(profileIdOf(vector.signPublicKey), vector.id)
  assert.equal(proofHeaders(vector, '11'.repeat(32), '22'.repeat(32))['x-mpfy-profile-proof'], VECTOR_PROOF)
  assert.deepEqual(checkProof(vector.id, VECTOR_PROOF, '11'.repeat(32), '22'.repeat(32)), { profileId: vector.id, signPublicKey: vector.signPublicKey.toString('hex') })
  assert.equal(checkProof(vector.id, VECTOR_PROOF, '12'.repeat(32), '22'.repeat(32)), null, 'another client key')
  assert.equal(checkProof(vector.id, VECTOR_PROOF, '11'.repeat(32), '23'.repeat(32)), null, 'another source')
  assert.equal(checkProof('0'.repeat(32), VECTOR_PROOF, '11'.repeat(32), '22'.repeat(32)), null, 'an id that is not the key\'s')
  assert.equal(checkProof(vector.id, VECTOR_PROOF.slice(2), '11'.repeat(32), '22'.repeat(32)), null, 'malformed')

  const { app, dir } = await start(t)
  const p = makeProfile()
  const phone = device(app, { profile: p, name: 'Telefono' })
  const r = await phone.call('GET', '/api/profile')
  assert.equal(r.status, 200)
  assert.deepEqual(body(r), {
    profileId: p.id, name: '', nameUpdatedAt: 0, photo: null, photoUpdatedAt: 0, role: 'member', recovery: null,
    source: { name: app.name, named: false, ownerProfileId: null, details: true },
    social: { v: 3, card: 0, privacy: 0, blocked: 0, mutes: 0, access: 0 }
  })
  assert.equal(readJson(dir, 'clients.json').find((c) => c.publicKey === phone.key).profileId, p.id, 'bound in clients.json')
  const rec = readJson(dir, 'profiles.json').profiles[0]
  assert.equal(rec.profileId, p.id)
  assert.equal(rec.signPublicKey, p.signPublicKey.toString('hex'))
  assert.equal(rec.name, '')
  assert.equal(rec.nameUpdatedAt, 0)
  assert.equal(rec.removedAt, null)

  // Another admitted device replays the phone's proof, or one made for another source.
  const other = device(app)
  for (const headers of [proofHeaders(p, phone.key, app.serverPublicKey), proofHeaders(p, other.key, 'ee'.repeat(32)), { 'x-mpfy-profile': p.id }]) {
    const res = await other.call('GET', '/api/library', { headers })
    assert.equal(res.status, 403)
    assert.deepEqual(body(res), { error: 'Profilo non valido', code: 'bad_profile' })
  }
  assert.equal(app.clients.get(other.key).profileId, undefined, 'nothing bound')
})

test('binding: a bound key naming another profile is refused; without headers it acts as its profile', async (t) => {
  const { app } = await start(t)
  const p = makeProfile()
  const q = makeProfile()
  const phone = device(app, { profile: p })
  assert.equal(body(await phone.call('GET', '/api/profile')).profileId, p.id)
  const r = await phone.call('GET', '/api/profile', { headers: proofHeaders(q, phone.key, app.serverPublicKey) })
  assert.equal(r.status, 403)
  assert.equal(body(r).code, 'bad_profile')
  const plain = await phone.call('GET', '/api/library', { withProfile: false })
  assert.equal(plain.status, 200)
  assert.deepEqual(body(plain).you, { profileId: p.id, role: 'member' })
  assert.equal(app.profiles.get(q.id), null, 'the other profile was never created')
})

test('roles: legacy key without headers is the owner, a new key without headers a guest (guest endpoints only), local is the owner', async (t) => {
  const key = deviceKey()
  const dir = cleanup(t).dir(tmpDir())
  olderDir(dir, { keys: [key] })
  const { app, port } = await start(t, { dir })
  assert.equal(app.clients.get(key).legacy, true)
  const legacy = device(app, { key, admit: false })
  let r = await legacy.call('GET', '/api/library')
  assert.equal(r.status, 200)
  assert.deepEqual(body(r).you, { profileId: null, role: 'owner' })
  assert.equal((await legacy.call('POST', '/api/admin/code/rotate')).status, 200, 'an older app of the owner rotates the code')

  const guest = device(app, { name: 'Nuovo telefono' })
  const allowed = [
    ['GET', '/api/health', 200],
    ['GET', '/api/profile', 200],
    ['GET', '/api/recovery/profiles', 200],
    ['GET', '/api/recovery/' + '1'.repeat(32) + '/' + guest.key, 404],
    ['POST', '/api/recovery/' + '1'.repeat(32) + '/' + guest.key + '/release', 404]
  ]
  for (const [method, url, status] of allowed) {
    const res = await guest.call(method, url, { body: method === 'POST' ? { verifier: 'a'.repeat(64) } : null })
    assert.equal(res.status, status, method + ' ' + url)
    if (status === 404) assert.equal(body(res).code, 'no_recovery')
  }
  assert.equal(body(await guest.call('GET', '/api/profile')).role, 'guest')
  for (const [method, url] of [['GET', '/api/library'], ['PUT', '/api/upload/x.wav'], ['GET', '/api/admin/code'], ['GET', '/api/admin/clients'], ['POST', '/api/playlists'], ['GET', '/api/stream/' + 'a'.repeat(24)], ['PUT', '/api/recovery']]) {
    const res = await guest.call(method, url, { body: method === 'GET' ? null : {} })
    assert.equal(res.status, 403, method + ' ' + url)
    assert.deepEqual(body(res), { error: 'Profilo mancante', code: 'no_profile' })
  }
  assert.equal((await guest.call('DELETE', '/api/admin/clients/self')).status, 200, 'a guest may remove itself')
  assert.equal(app.clients.has(guest.key), false)

  r = await request(port, 'GET', '/api/library')
  assert.deepEqual(body(r).you, { profileId: null, role: 'owner' }, 'local')
  // A local request with profile headers is still the local owner.
  r = await request(port, 'GET', '/api/profile', { headers: proofHeaders(makeProfile(), key, app.serverPublicKey) })
  assert.equal(body(r).role, 'owner')
  assert.equal(body(r).profileId, null)
  // From 127.0.0.2 without a mapping: refused before any handler.
  r = await request(port, 'GET', '/api/health', { localAddress: '127.0.0.2' })
  assert.equal(r.status, 403)
  assert.deepEqual(body(r), { error: 'Non consentito', code: 'forbidden' })
})

test('transport: the role is resolved at arrival (a channel closed during the pipeline keeps it); 127.0.0.2 without mapping is 403', { timeout: 120000 }, async (t) => {
  const testnet = await createTestnet(3)
  const c = cleanup(t)
  const dir = c.dir(tmpDir())
  const work = c.dir(tmpDir('mpfy-fp-'))
  const fpcalc = fakeTool(work, 'fpcalc', { delayMs: 1500 })
  const nodes = [testnet.createNode(), testnet.createNode(), testnet.createNode()]
  const app = await createMPfy({ dataDir: dir, port: 0, adminPort: 0, p2p: true, waitForDht: true, dht: nodes[0], ffmpeg: null, fpcalc: fpcalc.command, sevenZip: null, debounceMs: 10 })
  let link = null
  t.after(async () => {
    if (link) await link.close()
    await app.close()
    await Promise.all(nodes.map((n) => n.destroy()))
    await testnet.destroy()
  })
  const keyPair = generateKeyPair()
  await pair(app.code, { keyPair, name: 'Telefono', dht: nodes[1], timeout: 20000 })
  link = new MPfyLink({ serverPublicKey: app.serverPublicKey, keyPair, dht: nodes[2] })
  link.start()
  assert.equal(await link.waitConnected(15000), true)
  const p = makeProfile()
  const headers = proofHeaders(p, keyPair.publicKey, app.serverPublicKey)
  assert.equal((await link.request('GET', '/api/profile', { headers })).status, 200)

  // An upload through a raw channel; the channel goes away once the body is in,
  // while fpcalc (1.5 s here) still runs inside the pipeline.
  const wav = makeWav({ freq: 377, seconds: 2 })
  const stream = await link.openStream()
  stream.on('error', () => {})
  let head = 'PUT /api/upload/canale.wav HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: ' + wav.length + '\r\n'
  for (const [k, v] of Object.entries(headers)) head += k + ': ' + v + '\r\n'
  stream.write(Buffer.concat([Buffer.from(head + '\r\n', 'latin1'), wav]))
  await waitFor(() => fpcalc.calls().some((x) => x.started), { what: 'the body in and fpcalc started' })
  stream.destroy()
  await waitFor(() => app.transport.channels().length === 0, { what: 'the port mapping gone' })
  assert.equal(app.library.tracks.size, 0, 'fpcalc still runs: the pipeline has not reached the decision yet')
  const track = await waitFor(() => [...app.library.tracks.values()][0], { what: 'the track added', timeout: 15000 })
  assert.deepEqual(track.uploaders, [p.id], 'added as the profile that sent it, not as the owner')

  const r = await request(app.ports.http, 'GET', '/api/health', { localAddress: '127.0.0.2' })
  assert.equal(r.status, 403)
  assert.equal(body(r).code, 'forbidden')
})

test('claim: a legacy binding claims and takes the owner data; without a legacy key or the window nobody claims', async (t) => {
  const key = deviceKey()
  const T = (n) => n.toString(16).padStart(24, '0')
  const dir = cleanup(t).dir(tmpDir())
  olderDir(dir, {
    keys: [key],
    playlists: [{ id: '0123456789abcdef', name: 'Vecchia', description: '', trackIds: [T(1)], createdAt: 1, updatedAt: 1 }],
    likes: [{ id: T(2), at: 5 }],
    recents: [{ trackId: T(3), at: 7, context: { type: 'library' } }]
  })
  let { app, port } = await start(t, { dir })
  // A session the owner started locally before the claim, and records of a
  // pending upload and an archive (written as an earlier run left them).
  const session = body(await request(port, 'POST', '/api/uploads', { body: { name: 'grande.flac', size: 50e6, lastModified: 1, headHash: 'a'.repeat(64) } }))
  await app.close()
  fs.mkdirSync(path.join(dir, 'pending'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'pending', 'aaaaaaaaaaaaaaaa.wav'), makeWav())
  fs.writeFileSync(path.join(dir, 'pending', 'aaaaaaaaaaaaaaaa.json'), JSON.stringify({ id: 'aaaaaaaaaaaaaaaa', profileId: 'owner', ext: 'wav', name: 'x.wav', fileHash: T(9), matchTrackId: T(8), ber: 0.15, candidate: {}, archiveId: null, createdAt: Date.now(), expiresAt: Date.now() + 1e7, fp: null }))
  fs.writeFileSync(path.join(dir, 'archives', 'bbbbbbbbbbbbbbbb.json'), JSON.stringify({ id: 'bbbbbbbbbbbbbbbb', name: 'a.zip', state: 'done', pending: [], trackIds: [], profileId: 'owner', finishedAt: Date.now() }))
  ;({ app, port } = await start(t, { dir }))
  assert.ok(fs.existsSync(path.join(dir, 'users', 'owner.log')))

  const p = makeProfile()
  const phone = device(app, { profile: p, key, admit: false })
  const r = await phone.call('GET', '/api/library')
  assert.equal(r.status, 200)
  assert.deepEqual(body(r).you, { profileId: p.id, role: 'owner' }, 'the legacy key claimed for its profile')
  assert.deepEqual(body(r).playlists.map((x) => x.name), ['Vecchia'])
  assert.deepEqual(body(r).likes.map((x) => x.id), [T(2)])
  assert.deepEqual(body(r).recents.map((x) => x.trackId), [T(3)])
  assert.equal(app.source.ownerProfileId, p.id)
  assert.ok(!fs.existsSync(path.join(dir, 'users', 'owner.log')), 'users/owner.log moved')
  assert.ok(fs.existsSync(path.join(dir, 'users', p.id + '.log')))
  assert.equal(readJson(dir, 'uploads/' + session.id + '.json').profileId, p.id, 'the unfinished session is the profile\'s now')
  assert.equal(readJson(dir, 'pending/aaaaaaaaaaaaaaaa.json').profileId, p.id)
  assert.equal(readJson(dir, 'archives/bbbbbbbbbbbbbbbb.json').profileId, p.id)
  assert.equal(body(await phone.call('GET', '/api/uploads/' + session.id)).id, session.id)

  // A second profile, even on another legacy key, never claims: there is an owner.
  const fresh = await start(t)
  const q = device(fresh.app, { profile: makeProfile() })
  assert.equal(body(await q.call('GET', '/api/profile')).role, 'member', 'a fresh source: nobody claims without the window')
  assert.equal(fresh.app.source.ownerProfileId, null)
})

test('claim: the window (claim or code with no owner) lets the first new profile claim and closes; removing the last legacy key opens nothing; a bound member never claims later', async (t) => {
  const legacyKey = deviceKey()
  const dir = cleanup(t).dir(tmpDir())
  olderDir(dir, { keys: [legacyKey] })
  const { app, port } = await start(t, { dir })
  const opts = { dataDir: dir, port }
  // The last legacy key goes: nothing opens.
  assert.deepEqual(await runCommand(['revoke', legacyKey], opts), ['Dispositivo rimosso: le sue connessioni sono state chiuse.'])
  const sister = device(app, { profile: makeProfile(), name: 'Sorella' })
  assert.equal(body(await sister.call('GET', '/api/profile')).role, 'member')
  assert.equal(app.source.ownerProfileId, null)

  // claim: the window opens; an already bound profile (a second device of the
  // sister) does not claim, the first new one does, and the window closes.
  const [line] = await runCommand(['claim', '15'], opts)
  assert.equal(line, 'Finestra aperta per 15 minuti: il primo profilo che aggiunge la fonte ne diventa il proprietario.')
  assert.ok(app.source.claimUntil > Date.now() + 14 * 60000)
  const sister2 = device(app, { profile: sister.profile, name: 'PC della sorella' })
  assert.equal(body(await sister2.call('GET', '/api/profile')).role, 'member', 'already bound here: never claims')
  assert.equal(app.source.ownerProfileId, null)
  const owner = device(app, { profile: makeProfile(), name: 'Bacca' })
  assert.equal(body(await owner.call('GET', '/api/profile')).role, 'owner')
  assert.equal(app.source.claimUntil, 0, 'the window closed at the claim')
  const late = device(app, { profile: makeProfile() })
  assert.equal(body(await late.call('GET', '/api/profile')).role, 'member')
  assert.deepEqual(await runCommand(['claim'], opts), ["La fonte ha gia' un proprietario."])
  assert.deepEqual(await runCommand(['code'], opts), [app.code], 'with an owner, code only prints the code')

  // code with no owner (another fresh source) opens the window too.
  const other = await start(t)
  const lines = await runCommand(['code'], { dataDir: other.dir, port: other.port })
  assert.equal(lines.length, 2)
  const first = device(other.app, { profile: makeProfile() })
  assert.equal(body(await first.call('GET', '/api/profile')).role, 'owner')
  // Remote callers may not open the window or change the owner.
  for (const [url, b] of [['/api/admin/claim', {}], ['/api/admin/owner', { profileId: first.profile.id }]]) {
    const res = await first.call('POST', url, { body: b })
    assert.equal(res.status, 403)
    assert.equal(body(res).code, 'forbidden')
  }
})

test('set-owner: running and stopped; the older data merged into an existing user file; --move-data moves a wrong owner; an interrupted move finishes at start', async (t) => {
  const T = (n) => n.toString(16).padStart(24, '0')
  const dir = cleanup(t).dir(tmpDir())
  olderDir(dir, {
    tracks: [],
    playlists: [{ id: '1111111111111111', name: 'Dal telefono vecchio', description: '', trackIds: [T(1)], createdAt: 1, updatedAt: 1 }],
    likes: [{ id: T(1), at: 10 }, { id: T(2), at: 20 }],
    recents: [{ trackId: T(1), at: 100, context: { type: 'library' } }]
  })
  let { app, port } = await start(t, { dir })
  const bacca = device(app, { profile: makeProfile(), name: 'Telefono di Bacca' })
  // Bacca joined as a member first, with data of his own.
  assert.equal(body(await bacca.call('GET', '/api/profile')).role, 'member')
  await bacca.call('POST', '/api/playlists', { body: { name: 'Nuova' } })
  await bacca.call('PUT', '/api/likes/' + T(2))
  await bacca.call('POST', '/api/played', { body: { trackId: T(5), at: Date.now() - 1000 } })
  const opts = { dataDir: dir, port }
  const lines = await runCommand(['profiles'], opts)
  assert.match(lines[0], new RegExp('^' + bacca.profile.id + '  \\(senza nome\\)  membro$'))
  assert.match(lines[1], /^ {4}Telefono di Bacca {2}dal \d{4}-\d{2}-\d{2}$/)

  assert.deepEqual(await runCommand(['set-owner', bacca.profile.id], opts), ['Proprietario impostato: ' + bacca.profile.id + '.'])
  let lib = body(await bacca.call('GET', '/api/library'))
  assert.deepEqual(lib.you.role, 'owner')
  assert.deepEqual(lib.playlists.map((x) => x.name).sort(), ['Dal telefono vecchio', 'Nuova'], 'playlists appended once')
  assert.deepEqual(lib.likes.map((x) => x.id), [T(2), T(1)], 'likes united, newest first')
  assert.deepEqual(lib.recents.map((x) => x.trackId), [T(5), T(1)], 'recents united by time')
  assert.ok(!fs.existsSync(path.join(dir, 'users', 'owner.log')))
  assert.ok(!fs.existsSync(path.join(dir, 'users', 'owner.json')))

  // A wrong profile became owner; --move-data with the server stopped hands its
  // data and its tracks to the right one at the next start.
  const right = device(app, { profile: makeProfile(), name: 'Telefono nuovo' })
  assert.equal(body(await right.call('GET', '/api/profile')).role, 'member')
  const wav = makeWav({ freq: 640 })
  const up = body(await bacca.call('PUT', '/api/upload/mio.wav', { body: wav }))
  assert.equal(up.track.mine, true)
  await app.close()
  assert.deepEqual(await runCommand(['set-owner', right.profile.id, '--move-data'], { dataDir: dir, port }),
    ['Proprietario impostato: ' + right.profile.id + ' (dati spostati al prossimo avvio) (server spento).'])
  assert.deepEqual(readJson(dir, 'source.json').move, { from: bacca.profile.id, to: right.profile.id }, 'the move waits in source.json')
  ;({ app, port } = await start(t, { dir }))
  const right2 = right.on(app)
  const bacca2 = bacca.on(app)
  assert.equal(readJson(dir, 'source.json').move, undefined, 'finished at start')
  lib = body(await right2.call('GET', '/api/library'))
  assert.equal(lib.you.role, 'owner')
  assert.deepEqual(lib.playlists.map((x) => x.name).sort(), ['Dal telefono vecchio', 'Nuova'])
  assert.equal(lib.tracks[0].mine, true, 'the wrong owner\'s tracks are the right one\'s now')
  assert.deepEqual(app.library.getTrack(up.track.id).uploaders, [right.profile.id])
  assert.ok(!fs.existsSync(path.join(dir, 'users', bacca.profile.id + '.log')))
  assert.equal(body(await bacca2.call('GET', '/api/profile')).role, 'member')

  // Running server: --move-data back, through the API; an unknown profile is refused.
  await assert.rejects(runCommand(['set-owner', 'f'.repeat(32)], { dataDir: dir, port }), /Profilo non trovato/)
  assert.deepEqual(await runCommand(['set-owner', bacca.profile.id, '--move-data'], { dataDir: dir, port }), ['Proprietario impostato: ' + bacca.profile.id + ' (dati spostati).'])
  assert.deepEqual(app.library.getTrack(up.track.id).uploaders, [bacca.profile.id])
})

test('remove-profile: devices removed, files deleted, its proof refused afterwards; the owner\'s own refused; offline too', async (t) => {
  const { app, dir, port } = await start(t)
  app.people.openClaim(30)
  const owner = device(app, { profile: makeProfile() })
  assert.equal(body(await owner.call('GET', '/api/profile')).role, 'owner')
  const sister = device(app, { profile: makeProfile(), name: 'Sorella' })
  const wav = makeWav({ freq: 712 })
  const t1 = body(await sister.call('PUT', '/api/upload/suo.wav', { body: wav })).track
  body(await owner.call('PUT', '/api/upload/anche-mio.wav', { body: wav }))
  await sister.call('PUT', '/api/likes/' + t1.id)
  assert.equal((await sister.call('PUT', '/api/recovery', { body: recoveryBody() })).status, 200)
  app.users.flush()
  assert.ok(fs.existsSync(path.join(dir, 'users', sister.profile.id + '.log')))
  assert.ok(fs.existsSync(path.join(dir, 'recovery', sister.profile.id + '.json')))

  const opts = { dataDir: dir, port }
  await assert.rejects(runCommand(['remove-profile', owner.profile.id], opts), /Non consentito/)
  assert.equal((await sister.call('DELETE', '/api/admin/profiles/' + owner.profile.id)).status, 403, 'members cannot remove people')
  assert.deepEqual(await runCommand(['remove-profile', sister.profile.id], opts), ['Profilo rimosso: dispositivi, dati e recupero eliminati.'])
  assert.equal(app.clients.has(sister.key), false)
  assert.ok(!fs.existsSync(path.join(dir, 'users', sister.profile.id + '.log')))
  assert.ok(!fs.existsSync(path.join(dir, 'recovery', sister.profile.id + '.json')))
  assert.deepEqual(app.library.getTrack(t1.id).uploaders, [owner.profile.id], 'out of uploaders, no file deleted')
  assert.ok(fs.existsSync(app.library.trackPath(app.library.getTrack(t1.id))))
  // Paired again with the code, its proof binds nothing.
  const back = device(app, { profile: sister.profile })
  const r = await back.call('GET', '/api/profile')
  assert.equal(r.status, 403)
  assert.equal(body(r).code, 'bad_profile')
  assert.equal(app.clients.get(back.key).profileId, undefined)
  assert.deepEqual(body(await owner.call('GET', '/api/admin/profiles')).profiles.map((p) => p.profileId), [owner.profile.id], 'removed profiles left out')

  // Offline: marked in profiles.json and its devices out of clients.json at once,
  // its tracks freed at the next start.
  const third = device(app, { profile: makeProfile() })
  const t3 = body(await third.call('PUT', '/api/upload/terzo.wav', { body: makeWav({ freq: 813 }) })).track
  await app.close()
  assert.deepEqual(await runCommand(['remove-profile', third.profile.id], opts), ['Profilo rimosso (server spento): il resto al prossimo avvio.'])
  assert.ok(readJson(dir, 'profiles.json').profiles.find((p) => p.profileId === third.profile.id).removedAt > 0)
  const again = await start(t, { dir })
  assert.deepEqual(again.app.library.getTrack(t3.id).uploaders, [])
  assert.equal(again.app.clients.has(third.key), false)
})

test('a wrong first owner fixed with the server stopped: set-owner --move-data, then remove-profile; the right owner gets the data at start', async (t) => {
  const T = (n) => n.toString(16).padStart(24, '0')
  const dir = cleanup(t).dir(tmpDir())
  olderDir(dir, {
    playlists: [{ id: '2222222222222222', name: 'Dal telefono vecchio', description: '', trackIds: [T(1)], createdAt: 1, updatedAt: 1 }],
    likes: [{ id: T(2), at: 5 }],
    recents: [{ trackId: T(2), at: 50, context: { type: 'library' } }]
  })
  let { app, port } = await start(t, { dir })
  app.people.openClaim(30)
  const wrong = device(app, { profile: makeProfile(), name: 'Sorella' })
  assert.equal(body(await wrong.call('GET', '/api/profile')).role, 'owner')
  const right = device(app, { profile: makeProfile(), name: 'Bacca' })
  assert.equal(body(await right.call('GET', '/api/profile')).role, 'member')
  const up = body(await wrong.call('PUT', '/api/upload/suo.wav', { body: makeWav({ freq: 733 }) })).track
  assert.deepEqual(body(await wrong.call('GET', '/api/library')).playlists.map((x) => x.name), ['Dal telefono vecchio'])
  await app.close()

  const opts = { dataDir: dir, port }
  await runCommand(['set-owner', right.profile.id, '--move-data'], opts)
  assert.deepEqual(await runCommand(['remove-profile', wrong.profile.id], opts), ['Profilo rimosso (server spento): il resto al prossimo avvio.'])
  assert.ok(fs.existsSync(path.join(dir, 'users', wrong.profile.id + '.log')), 'kept for the move at start')
  ;({ app } = await start(t, { dir }))
  const lib = body(await right.on(app).call('GET', '/api/library'))
  assert.equal(lib.you.role, 'owner')
  assert.deepEqual(lib.playlists.map((x) => x.name), ['Dal telefono vecchio'], 'the data from before reached the right owner')
  assert.deepEqual(lib.likes.map((x) => x.id), [T(2)])
  assert.deepEqual(lib.recents.map((x) => x.trackId), [T(2)])
  assert.deepEqual(app.library.getTrack(up.id).uploaders, [right.profile.id], 'and the tracks')
  assert.ok(!fs.existsSync(path.join(dir, 'users', wrong.profile.id + '.log')))
  assert.equal(readJson(dir, 'source.json').move, undefined)
  assert.equal((await wrong.on(app).call('GET', '/api/profile')).status, 403, 'the removed profile is out')
})

test('remove-profile: its archive stops, nothing it was importing lands after the removal, its queued archive never runs', async (t) => {
  const work = cleanup(t).dir(tmpDir('mpfy-tools-'))
  const fpcalc = fakeTool(work, 'fpcalc', { delayMs: 300 })
  const { app, dir } = await start(t, { fpcalc: fpcalc.command })
  await app.jobsStarted
  app.people.openClaim(30)
  const owner = device(app, { profile: makeProfile() })
  assert.equal(body(await owner.call('GET', '/api/profile')).role, 'owner')
  const sara = device(app, { profile: makeProfile(), name: 'Sara' })
  const zip = (seed) => makeZip(Array.from({ length: 6 }, (_, i) => ({ name: 'Album/0' + i + '.wav', data: makeWav({ seconds: 2, freq: seed + i * 37 }) })))
  const first = await sara.call('PUT', '/api/upload/primo.zip', { body: zip(500) })
  const second = await sara.call('PUT', '/api/upload/secondo.zip', { body: zip(900) })
  assert.deepEqual([first.status, second.status], [202, 202])
  await waitFor(() => app.library.tracks.size >= 1, { what: 'the first entry imported' })
  const printed = () => fpcalc.calls().filter((c) => c.key && !c.started).length
  assert.equal((await owner.call('DELETE', '/api/admin/profiles/' + sara.profile.id)).status, 200)
  const atRemoval = app.library.tracks.size
  const printsAtRemoval = printed()
  // The queued one goes at once, file and status, without waiting for its turn.
  const queued = body(second).archive.id
  assert.equal(app.archives.record(queued), null)
  assert.ok(!fs.existsSync(path.join(dir, 'tmp', 'a-' + queued + '.zip')))
  await app.archives.idle()
  await new Promise((resolve) => setTimeout(resolve, 400))
  const ups = [...app.library.tracks.values()].map((x) => x.uploaders)
  assert.ok(ups.every((u) => !u.includes(sara.profile.id)), 'no track names the removed profile: ' + JSON.stringify(ups))
  assert.equal(app.library.tracks.size, atRemoval, 'nothing more imported')
  assert.ok(printed() - printsAtRemoval <= 1, 'at most the entry already under way is read: ' + (printed() - printsAtRemoval))
  assert.equal(app.archives.record(body(first).archive.id), null)
  assert.equal(app.archives.record(body(second).archive.id), null)
  assert.deepEqual(fs.readdirSync(path.join(dir, 'archives')), [])
  assert.deepEqual(fs.readdirSync(path.join(dir, 'tmp')), [])
})

test('profiles.json that does not parse is never written over: a removed profile cannot bind again as a new one', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  let { app } = await start(t, { dir })
  app.people.openClaim(30)
  const owner = device(app, { profile: makeProfile() })
  assert.equal(body(await owner.call('GET', '/api/profile')).role, 'owner')
  const member = device(app, { profile: makeProfile() })
  const sister = device(app, { profile: makeProfile() })
  assert.equal(body(await member.call('GET', '/api/profile')).role, 'member')
  assert.equal(body(await sister.call('GET', '/api/profile')).role, 'member')
  assert.equal((await owner.call('DELETE', '/api/admin/profiles/' + sister.profile.id)).status, 200)
  await app.close()
  // A hand edit leaves a stray comma.
  const file = path.join(dir, 'profiles.json')
  const broken = fs.readFileSync(file, 'utf8').replace(/]\s*}\s*$/, ',]}')
  fs.writeFileSync(file, broken)
  ;({ app } = await start(t, { dir }))
  // Paired again with the code, the removed profile tries to bind as if new.
  const back = device(app, { profile: sister.profile })
  assert.notEqual((await back.call('GET', '/api/profile')).status, 200)
  assert.equal(app.clients.get(back.key).profileId, undefined, 'nothing bound')
  assert.equal(fs.readFileSync(file, 'utf8'), broken, 'the file is untouched')
  // Devices already bound keep working meanwhile.
  assert.equal(body(await member.on(app).call('GET', '/api/profile')).role, 'member')
  assert.equal(body(await owner.on(app).call('GET', '/api/profile')).role, 'owner')
  // Fixed by hand: read again, and the removal still holds.
  fs.writeFileSync(file, broken.replace(',]}', ']}'))
  assert.equal(body(await back.call('GET', '/api/profile')).code, 'bad_profile')
  assert.equal(body(await device(app, { profile: makeProfile() }).call('GET', '/api/profile')).role, 'member')
})

function recoveryBody (updatedAt = Date.now()) {
  return { salt: '0'.repeat(32), opslimit: 3, memlimit: 67108864, verifierHash: 'b'.repeat(64), blob: Buffer.concat([Buffer.from([1]), Buffer.alloc(40, 7)]).toString('base64'), updatedAt }
}

test('limits: a profile binds its 9th and 20th key, the 101st profile binds; pairing admits past 256 clients, never more than 20 in an hour', async (t) => {
  const { app } = await start(t)
  const p = makeProfile()
  const keys = []
  for (let i = 0; i < 20; i++) {
    const d = device(app, { profile: p })
    const r = await d.call('GET', '/api/profile')
    assert.equal(r.status, 200, 'key ' + (i + 1))
    assert.equal(body(r).profileId, p.id)
    keys.push(d.key)
  }
  assert.equal(app.clients.get(keys[8]).profileId, p.id, 'the 9th key is bound')
  assert.equal(app.clients.get(keys[19]).profileId, p.id, 'the 20th key is bound')
  assert.equal(app.clients.boundTo(p.id).length, 20)

  // 99 more profiles make 100; the 101st binds like any other and is listed.
  for (let i = 0; i < 99; i++) assert.equal((await device(app, { profile: makeProfile() }).call('GET', '/api/profile')).status, 200)
  assert.equal(app.profiles.active().length, 100)
  const last = makeProfile()
  const lastDevice = device(app, { profile: last })
  const r = await lastDevice.call('GET', '/api/profile')
  assert.equal(r.status, 200)
  assert.equal(body(r).profileId, last.id)
  assert.equal(body(r).role, 'member')
  assert.equal(app.profiles.active().length, 101)
  assert.notEqual(app.profiles.get(last.id), null)
  assert.equal(app.clients.get(lastDevice.key).profileId, last.id, 'the 101st profile is bound')

  // The pairing admission, with its production limit: 20 new keys in any hour,
  // however many are admitted already; an already admitted key is only confirmed.
  let now = 0
  const admitted = new Set()
  const clients = { has: (k) => admitted.has(k), list: () => [...admitted] }
  const limiter = new AdmissionLimiter({ now: () => now })
  for (let i = 0; i < 20; i++) {
    limiter.check(clients, 'k' + i)
    admitted.add('k' + i)
  }
  assert.throws(() => limiter.check(clients, 'k20'), /this hour/, 'the 21st pairing in an hour')
  limiter.check(clients, 'k3')
  // Hour after hour, 20 at a time, well past 256.
  let n = 20
  while (n < 300) {
    now += 3600001
    for (let i = 0; i < 20; i++, n++) {
      limiter.check(clients, 'k' + n)
      admitted.add('k' + n)
    }
  }
  assert.equal(admitted.size, 300)
  assert.throws(() => limiter.check(clients, 'nuovo'), /this hour/, 'at 300 clients, still the hourly limit only')
  limiter.check(clients, 'k299')
  now += 3600001
  limiter.check(clients, 'nuovo')
  admitted.add('nuovo')
  assert.equal(admitted.size, 301)
})

test('limits over P2P: past the hourly pairings the pairing listener closes without admitting', { timeout: 120000 }, async (t) => {
  const testnet = await createTestnet(3)
  const dir = cleanup(t).dir(tmpDir())
  const nodes = [testnet.createNode(), testnet.createNode()]
  const app = await createMPfy({ dataDir: dir, port: 0, adminPort: 0, p2p: true, waitForDht: true, dht: nodes[0], ffmpeg: null, fpcalc: null, sevenZip: null, admitLimits: { perHour: 1 } })
  t.after(async () => {
    await app.close()
    await Promise.all(nodes.map((n) => n.destroy()))
    await testnet.destroy()
  })
  const a = generateKeyPair()
  await pair(app.code, { keyPair: a, name: 'Uno', dht: nodes[1], timeout: 20000 })
  await pair(app.code, { keyPair: a, name: 'Uno', dht: nodes[1], timeout: 20000 }) // confirmed again: fine
  await assert.rejects(pair(app.code, { keyPair: generateKeyPair(), name: 'Due', dht: nodes[1], timeout: 8000 }))
  assert.equal(app.clients.list().length, 1)
})

test('names: 1..40 code points (emoji count once), first PATCH of a fresh record stored, newest wins; source name owner only; MPFY_NAME never overrides a saved name', async (t) => {
  let { app, dir } = await start(t, { name: 'Mi A2' })
  app.people.openClaim(30)
  const owner = device(app, { profile: makeProfile() })
  const member = device(app, { profile: makeProfile() })
  assert.equal(body(await owner.call('GET', '/api/profile')).role, 'owner')
  let r = await member.call('PATCH', '/api/profile', { body: { name: '  Sara  ', nameUpdatedAt: 1 } })
  assert.equal(r.status, 200)
  assert.equal(body(r).name, 'Sara', 'a fresh record (time 0) takes any first time')
  assert.equal(body(r).nameUpdatedAt, 1)
  r = await member.call('PATCH', '/api/profile', { body: { name: 'Vecchio', nameUpdatedAt: 0 } })
  assert.equal(body(r).name, 'Sara', 'an older time changes nothing')
  r = await member.call('PATCH', '/api/profile', { body: { name: 'Futuro', nameUpdatedAt: Date.now() + 3600e3 } })
  assert.equal(body(r).name, 'Sara', 'too far in the future')
  const emoji = '\u{1F3B5}'.repeat(40)
  r = await member.call('PATCH', '/api/profile', { body: { name: emoji, nameUpdatedAt: Date.now() } })
  assert.equal(body(r).name, emoji, '40 code points, 80 UTF-16 units')
  for (const bad of ['', '   ', 'x'.repeat(41), '\u{1F3B5}'.repeat(41), 7]) {
    r = await member.call('PATCH', '/api/profile', { body: { name: bad, nameUpdatedAt: Date.now() + 1000 } })
    assert.equal(r.status, 400)
    assert.equal(body(r).code, 'bad_name')
  }
  assert.equal((await request(app.ports.http, 'PATCH', '/api/profile', { body: { name: 'X', nameUpdatedAt: 5 } })).status, 403, 'the owner without a profile has no name')

  r = await member.call('PATCH', '/api/admin/source', { body: { name: 'Mia' } })
  assert.equal(r.status, 403)
  r = await owner.call('PATCH', '/api/admin/source', { body: { name: 'Casa \u{1F3E0}'.padEnd(10, '!') } })
  assert.equal(r.status, 200)
  const named = body(r).source.name
  assert.deepEqual(body(r), { source: { name: named, named: true, details: true } })
  assert.equal((await owner.call('PATCH', '/api/admin/source', { body: { name: 'x'.repeat(41) } })).status, 400)
  assert.equal(body(await member.call('GET', '/api/health')).name, named)
  const lib = body(await member.call('GET', '/api/library'))
  assert.deepEqual(lib.source, { name: named, named: true, details: true, social: 3 })

  // A restart with MPFY_NAME (the deploy sets it at every start) keeps the saved name.
  await app.close()
  ;({ app } = await start(t, { dir, name: 'Mi A2' }))
  assert.equal(app.name, named)
  assert.equal(body(await request(app.ports.http, 'GET', '/api/health')).name, named)
})

test('owner only: rotate code, rename the source, list and remove profiles; devices filtered for members; a member removes only its own; removing a device drops its binding and recovery blob', async (t) => {
  const { app } = await start(t)
  app.people.openClaim(30)
  const owner = device(app, { profile: makeProfile(), name: 'Bacca' })
  assert.equal(body(await owner.call('GET', '/api/profile')).role, 'owner')
  const sara = makeProfile()
  const phone = device(app, { profile: sara, name: 'Telefono di Sara' })
  const pc = device(app, { profile: sara, name: 'PC di Sara' })
  const marco = device(app, { profile: makeProfile(), name: 'Marco' })
  for (const d of [phone, pc, marco]) assert.equal((await d.call('GET', '/api/profile')).status, 200)
  assert.equal((await pc.call('PUT', '/api/recovery', { body: recoveryBody() })).status, 200)

  for (const [method, url, b] of [['POST', '/api/admin/code/rotate'], ['PATCH', '/api/admin/source', { name: 'X' }], ['GET', '/api/admin/profiles'], ['DELETE', '/api/admin/profiles/' + owner.profile.id]]) {
    const r = await phone.call(method, url, { body: b || null })
    assert.equal(r.status, 403, method + ' ' + url)
    assert.deepEqual(body(r), { error: 'Non consentito', code: 'forbidden' })
  }
  const listed = body(await owner.call('GET', '/api/admin/profiles')).profiles
  assert.deepEqual(listed.map((p) => [p.name, p.role, p.devices, p.recovery]).sort(), [['', 'member', 1, false], ['', 'member', 2, true], ['', 'owner', 1, false]])
  assert.ok(listed.every((p) => p.connected === 0 && p.createdAt > 0 && p.lastSeenAt > 0))
  const all = body(await owner.call('GET', '/api/admin/clients')).clients
  assert.equal(all.length, 4)
  assert.deepEqual(all.find((c) => c.publicKey === pc.key), { publicKey: pc.key, name: 'PC di Sara', addedAt: all.find((c) => c.publicKey === pc.key).addedAt, connected: false, you: false, profileId: sara.id, profileName: '', legacy: false })
  const own = body(await phone.call('GET', '/api/admin/clients')).clients
  assert.deepEqual(own.map((c) => [c.name, c.you]), [['Telefono di Sara', true], ['PC di Sara', false]])

  assert.equal((await phone.call('DELETE', '/api/admin/clients/' + marco.key)).status, 403, 'not hers')
  assert.equal((await phone.call('DELETE', '/api/admin/clients/' + pc.key)).status, 200, 'her own other device')
  assert.equal(app.clients.has(pc.key), false)
  assert.equal(app.recovery.deviceInfo(sara.id, pc.key), null, 'its recovery blob went with it')
  assert.equal((await owner.call('DELETE', '/api/admin/clients/' + marco.key)).status, 200, 'the owner removes anyone')
})
