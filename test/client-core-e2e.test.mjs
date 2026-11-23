// Client core end to end over the REAL public HyperDHT (needs Internet, UDP):
// two real sources (server/app.mjs) on random ports with temp data dirs, their
// permanent codes read through the module. The core makes a profile, adds the
// first source inside its claim window (it becomes the owner), then through
// /s/<id>/...: health, the UI, an upload of a generated WAV, the library, a like
// and its undo, a Range of the stream, the whole stream (throughput); the source
// renamed by its owner; password recovery on, a second source (a member there), a
// new device recovering the profile through it; DELETE of the first revokes this
// device on that source.
// Then client-node's "add", both through a core started for the moment and
// through the running one it finds by the lock of the state file.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMPfy } from '../server/app.mjs'
import { createClientCore, CSP } from '../client-core/index.js'
import { addSource, runClient } from '../client-node/index.mjs'
import { makeWav, tmpDir, rmDir, request, json, waitFor } from './helpers.mjs'

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web')

test('e2e: a profile, sources added with their codes (owner and member), health, upload, library, a like, Range, rename, password recovery on a new device, removal revokes this device; client-node add', { timeout: 420000 }, async (t) => {
  const started = Date.now()
  const mark = (what) => t.diagnostic(((Date.now() - started) / 1000).toFixed(1) + ' s ' + what)
  const dirA = tmpDir('mpfy-cce2e-a-')
  const dirB = tmpDir('mpfy-cce2e-b-')
  const dirC = tmpDir('mpfy-cce2e-client-')
  const dirN = tmpDir('mpfy-cce2e-new-')
  const statePath = path.join(dirC, 'state.json')
  let appA = null
  let appB = null
  let core = null
  let fresh = null
  let running = null
  t.after(async () => {
    if (core) await core.stop()
    if (fresh) await fresh.stop()
    if (running) await running.stop()
    if (appA) await appA.close()
    if (appB) await appB.close()
    for (const d of [dirA, dirB, dirC, dirN]) rmDir(d)
  })

  const opts = { port: 0, adminPort: 0, p2p: true, waitForDht: true, debounceMs: 20, ffmpeg: null, fpcalc: null, sevenZip: null }
  ;[appA, appB] = await Promise.all([
    createMPfy({ ...opts, dataDir: dirA, name: 'Fonte A' }),
    createMPfy({ ...opts, dataDir: dirB, name: 'Fonte B' })
  ])
  mark('two sources listening on the public DHT')
  const codeA = appA.code
  const codeB = appB.code
  assert.match(codeA, /^MPFY(-[0-9A-HJKMNP-TV-Z]{4}){8}$/)
  // A is set up the way the owner does it: the window opened on the source itself.
  appA.people.openClaim(30)

  const events = []
  core = createClientCore({ statePath, webRoot: WEB, port: 0, deviceName: 'PC di prova', onEvent: (e) => events.push(e) })
  const { port } = await core.start()
  const clientKey = core.state().publicKey
  mark('core started on port ' + port)

  const ui = await request(port, 'GET', '/')
  assert.equal(ui.status, 200)
  assert.equal(ui.headers['content-security-policy'], CSP)
  assert.match(ui.body.toString(), /<html/i)

  const made = await request(port, 'POST', '/local/profile', { body: { name: 'Prova' } })
  assert.equal(made.status, 201, made.body.toString())
  const profile = json(made).profile

  // First source, with the permanent code: the owner, by the window.
  const addA = await request(port, 'POST', '/local/sources', { body: { code: codeA }, timeout: 90000 })
  mark('source A added')
  assert.equal(addA.status, 201, addA.body.toString())
  const a = json(addA).source
  assert.equal(a.id, appA.serverPublicKey.slice(0, 8))
  assert.equal(a.name, 'Fonte A')
  assert.equal(a.principal, true)
  assert.ok(appA.clients.has(clientKey), 'source A admitted this device')
  assert.equal(appA.clients.list().find((c) => c.publicKey === clientKey).name, 'PC di prova')
  await waitFor(() => core.state().sources.find((s) => s.id === a.id).connected, { timeout: 60000, interval: 200, what: 'link to A' })
  await waitFor(async () => json(await request(port, 'GET', '/local/sources')).sources[0].role === 'owner', { timeout: 30000, interval: 200, what: 'the first sync' })
  mark('link to A up, synced')
  assert.equal(appA.source.ownerProfileId, profile.id, 'claimed by this profile')
  assert.equal(appA.profiles.get(profile.id).name, 'Prova', 'its name sent there')
  assert.ok(events.some((e) => e.type === 'sources' && e.sources.some((s) => s.id === a.id && s.connected)), 'connected announced')

  const health = await request(port, 'GET', '/s/' + a.id + '/api/health', { timeout: 30000 })
  assert.equal(health.status, 200)
  assert.equal(json(health).name, 'Fonte A')
  assert.equal(json(health).tracks, 0)

  // Upload (bigger than the 1 MB flow-control window), then library and Range.
  const wav = makeWav({ seconds: 100, sampleRate: 8000, freq: 523 })
  const up = await request(port, 'PUT', '/s/' + a.id + '/api/upload/' + encodeURIComponent('Prova core.wav'), { body: wav, timeout: 120000 })
  mark('upload of ' + wav.length + ' bytes through the core')
  assert.equal(up.status, 200, up.body.toString())
  const { track, duplicate } = json(up)
  assert.equal(duplicate, false)
  assert.equal(track.title, 'Prova core')
  assert.equal(track.size, wav.length)
  assert.equal(track.mine, true)

  const lib = await request(port, 'GET', '/s/' + a.id + '/api/library', { timeout: 30000 })
  assert.equal(lib.status, 200)
  assert.deepEqual(json(lib).tracks.map((x) => x.id), [track.id])
  assert.deepEqual(json(lib).you, { profileId: profile.id, role: 'owner' })

  // The heart of the media notification: a PUT with an empty body on the principal, then a DELETE.
  const liked = await request(port, 'PUT', '/s/' + a.id + '/api/likes/' + track.id, { headers: { 'content-length': '0' }, timeout: 30000 })
  assert.equal(liked.status, 200, liked.body.toString())
  assert.deepEqual(json(liked).likes.map((l) => l.id), [track.id])
  const unliked = await request(port, 'DELETE', '/s/' + a.id + '/api/likes/' + track.id, { timeout: 30000 })
  assert.equal(unliked.status, 200, unliked.body.toString())
  assert.deepEqual(json(unliked).likes, [])

  const start = 54321
  const end = 1200000
  const part = await request(port, 'GET', '/s/' + a.id + '/api/stream/' + track.id + '?q=high', { headers: { range: 'bytes=' + start + '-' + end }, timeout: 60000 })
  mark('Range through the core')
  assert.equal(part.status, 206)
  assert.equal(part.headers['content-range'], 'bytes ' + start + '-' + end + '/' + wav.length)
  assert.equal(part.headers['x-mpfy-quality'], 'max')
  assert.ok(part.body.equals(wav.subarray(start, end + 1)), 'Range bytes identical')

  // The whole stream, again until the meter has enough busy time to say something
  // (only stream bodies count, and both sources run on this PC: one 1.6 MB stream
  // can be over in less than the 100 ms the meter needs).
  let listed = null
  for (let i = 0; i < 8 && !(listed && listed.throughputKbps); i++) {
    const whole = await request(port, 'GET', '/s/' + a.id + '/api/stream/' + track.id, { timeout: 60000 })
    assert.equal(whole.status, 200)
    assert.ok(whole.body.equals(wav), 'whole stream identical')
    listed = json(await request(port, 'GET', '/local/sources')).sources[0]
  }
  mark('throughput ' + listed.throughputKbps + ' kbps, rtt ' + listed.rttMs + ' ms')
  assert.ok(Number.isInteger(listed.throughputKbps) && listed.throughputKbps > 0, 'throughput measured')

  // The source knows who is asking through the core.
  const clients = json(await request(port, 'GET', '/s/' + a.id + '/api/admin/clients', { timeout: 30000 })).clients
  assert.deepEqual(clients.map((c) => [c.publicKey, c.name, c.you, c.profileId]), [[clientKey, 'PC di prova', true, profile.id]])

  // The owner names the source; the core takes the name at its next sync.
  const renamed = await request(port, 'PATCH', '/s/' + a.id + '/api/admin/source', { body: { name: 'Casa' }, timeout: 30000 })
  assert.equal(renamed.status, 200, renamed.body.toString())
  assert.deepEqual(json(await request(port, 'POST', '/local/sync', { timeout: 30000 })), { ok: true })
  const afterRename = json(await request(port, 'GET', '/local/sources')).sources[0]
  assert.deepEqual([afterRename.name, afterRename.named, afterRename.role], ['Casa', true, 'owner'])

  // Password recovery on.
  const on = await request(port, 'PUT', '/local/profile/recovery', { body: { password: 'una frase breve' }, timeout: 60000 })
  assert.equal(on.status, 200, on.body.toString())
  assert.deepEqual(json(on), { recovery: true, sources: { [a.id]: 'ok' } })
  mark('recovery on')

  // A second source: a member there; it gets the blob too.
  const addB = await request(port, 'POST', '/local/sources', { body: { code: codeB }, timeout: 90000 })
  mark('source B added')
  assert.equal(addB.status, 201, addB.body.toString())
  const b = json(addB).source
  assert.equal(b.name, 'Fonte B', 'named after the source')
  assert.equal(b.principal, false)
  const healthB = await request(port, 'GET', '/s/' + b.id + '/api/health', { timeout: 60000 })
  assert.equal(json(healthB).name, 'Fonte B')
  await waitFor(async () => json(await request(port, 'GET', '/local/sources')).sources[1].role === 'member', { timeout: 30000, interval: 200, what: 'B synced' })
  await waitFor(() => appB.recovery.deviceInfo(profile.id, clientKey) !== null, { timeout: 30000, interval: 200, what: 'the blob on B' })
  const both = json(await request(port, 'GET', '/local/sources')).sources
  assert.deepEqual(both.map((s) => [s.id, s.principal, s.role, s.profiles]), [[a.id, true, 'owner', true], [b.id, false, 'member', true]])

  // A new device recovers the profile with B's code and the password.
  fresh = createClientCore({ statePath: path.join(dirN, 'state.json'), webRoot: WEB, port: 0, deviceName: 'Telefono nuovo' })
  const freshPort = (await fresh.start()).port
  const tempKey = fresh.state().publicKey
  const session = await request(freshPort, 'POST', '/local/recovery', { body: { code: codeB }, timeout: 90000 })
  mark('recovery session on B')
  assert.equal(session.status, 200, session.body.toString())
  const { sessionId, entries } = json(session)
  assert.deepEqual(entries, [{ profileId: profile.id, name: 'Prova', device: clientKey, deviceName: 'PC di prova' }])
  const back = await request(freshPort, 'POST', '/local/recovery/' + sessionId, { body: { profileId: profile.id, device: clientKey, password: 'una frase breve' }, timeout: 90000 })
  mark('profile recovered')
  assert.equal(back.status, 200, back.body.toString())
  assert.equal(json(back).profile.id, profile.id)
  assert.deepEqual(json(back).sources.map((s) => s.id), [a.id, b.id])
  assert.equal(fresh.state().publicKey, clientKey, 'the same device again')
  assert.equal(appB.clients.has(tempKey), false, 'the temporary key is gone')
  await fresh.stop()
  fresh = null

  // Removing A: this device is revoked there first, B becomes principal.
  const del = await request(port, 'DELETE', '/local/sources/' + a.id, { timeout: 30000 })
  mark('source A removed')
  assert.equal(del.status, 200)
  assert.deepEqual(json(del), { ok: true, revoked: true })
  assert.equal(appA.clients.has(clientKey), false, 'source A forgot this device')
  assert.ok(appB.clients.has(clientKey), 'source B did not')
  assert.equal((await request(port, 'GET', '/s/' + a.id + '/api/health')).status, 404)
  const after = json(await request(port, 'GET', '/local/sources')).sources
  assert.deepEqual(after.map((s) => [s.id, s.principal]), [[b.id, true]])
  const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  assert.deepEqual(saved.sources.map((s) => [s.id, s.name, s.principal]), [[b.id, 'Fonte B', true]])
  assert.equal(saved.profile.id, profile.id)
  await core.stop()
  core = null

  // client-node "add" with no client running: a core for the moment.
  const tmp = await addSource({ code: codeA, statePath, webRoot: WEB })
  mark('client-node add (temporary core)')
  assert.equal(tmp.via, 'temporary')
  assert.equal(fs.existsSync(statePath + '.lock'), false, 'the lock of the temporary core released')
  assert.equal(tmp.source.id, a.id)
  assert.equal(tmp.source.name, 'Casa')
  assert.equal(tmp.source.principal, false)
  assert.ok(appA.clients.has(clientKey), 'admitted again')

  // ... and with one running (on a port of its own): it goes through that one.
  running = (await runClient({ statePath, webRoot: WEB, port: 0 })).core
  const runningPort = running.state().port
  const again = await addSource({ code: codeB, statePath, webRoot: WEB })
  mark('client-node add (running core)')
  assert.equal(again.via, 'running')
  assert.equal(again.source.id, b.id)
  assert.deepEqual(running.state().sources.map((s) => [s.id, s.name, s.principal]), [[b.id, 'Fonte B', true], [a.id, 'Casa', false]])
  assert.equal((await request(runningPort, 'GET', '/s/' + a.id + '/api/health', { timeout: 60000 })).status, 200)
  mark('done')
})
