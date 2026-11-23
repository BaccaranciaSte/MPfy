// Password recovery on the source: one opaque blob per device, its Argon2id
// parameters fixed (3 and 64 MiB), the release for the verifier only, 5 wrong
// tries in an hour locking the profile for 1 h, 2 h, 4 h..., a release or a PUT
// resetting the doubling, the lock kept across a restart, guests listing and
// releasing.

import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createMPfy } from '../server/app.mjs'
import { RecoveryStore, validRecoveryBody } from '../server/recovery.mjs'
import { verifierHashOf } from '../server/proof.mjs'
import { tmpDir, cleanup, json, request, makeProfile, device, testWhoIs } from './helpers.mjs'

const body = (r) => json(r)
const HOUR = 3600e3

function secretPair () {
  const verifier = crypto.randomBytes(32)
  return { verifier: verifier.toString('hex'), verifierHash: verifierHashOf(verifier).toString('hex') }
}

function blobBody (verifierHash, updatedAt = Date.now(), extra = {}) {
  return { salt: crypto.randomBytes(16).toString('hex'), opslimit: 3, memlimit: 67108864, verifierHash, blob: Buffer.concat([Buffer.from([1]), crypto.randomBytes(80)]).toString('base64'), updatedAt, ...extra }
}

test('recovery: the verifier hash of the vector', () => {
  const out = Buffer.from('17adb8a631fe5b557dcf383880d1810613358c6697319365aa455d6b55f10a38923c385343fc7cc3a092495ed8116b0a7cbb1d197e599b4c0cdd658033470744', 'hex')
  assert.equal(verifierHashOf(out.subarray(32)).toString('hex'), '927e93a56c9a2b71aee79f4ba07e755ab3c879830451ba63b638f8bb18b5f4e3')
})

test('recovery: put, params, release; parameters other than 3 and 64 MiB are 400; wrong verifier 403 with triesLeft; guests list and release', async (t) => {
  const c = cleanup(t)
  const dir = c.dir(tmpDir())
  const app = c.close(await createMPfy({ dataDir: dir, port: 0, adminPort: 0, p2p: false, debounceMs: 10, ffmpeg: null, fpcalc: null, sevenZip: null, whoIs: testWhoIs }))
  const p = makeProfile()
  const phone = device(app, { profile: p, name: 'REDMAGIC 10 Pro' })
  await phone.call('PATCH', '/api/profile', { body: { name: 'Bacca', nameUpdatedAt: 5 } })
  const s = secretPair()
  for (const bad of [{ opslimit: 2 }, { memlimit: 33554432 }, { salt: 'xx' }, { verifierHash: '00' }, { blob: Buffer.from([2, 3]).toString('base64') }, { blob: 'non base64!' }, { blob: Buffer.concat([Buffer.from([1]), Buffer.alloc(65536)]).toString('base64') }, { updatedAt: 'ieri' }]) {
    const r = await phone.call('PUT', '/api/recovery', { body: blobBody(s.verifierHash, Date.now(), bad) })
    assert.equal(r.status, 400, JSON.stringify(bad).slice(0, 50))
  }
  assert.equal(validRecoveryBody(blobBody(s.verifierHash, 1, { blob: Buffer.concat([Buffer.from([1]), Buffer.alloc(65535)]).toString('base64') })) !== null, true, '64 KiB exactly is fine')
  const first = blobBody(s.verifierHash, 1000)
  let r = await phone.call('PUT', '/api/recovery', { body: first })
  assert.deepEqual(body(r), { ok: true, updatedAt: 1000 })
  r = await phone.call('PUT', '/api/recovery', { body: blobBody(s.verifierHash, 500) })
  assert.deepEqual(body(r), { ok: true, updatedAt: 1000 }, 'an older blob is not stored')
  assert.deepEqual(body(await phone.call('GET', '/api/profile')).recovery, { updatedAt: 1000 })
  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'recovery', p.id + '.json'), 'utf8'))
  assert.deepEqual(Object.keys(stored.devices), [phone.key])
  assert.equal(stored.devices[phone.key].deviceName, 'REDMAGIC 10 Pro')
  assert.equal(JSON.stringify(stored).includes(s.verifier), false, 'the source never holds the verifier')

  // A new device (a guest) finds the profile, reads the parameters, releases.
  const guest = device(app, { name: 'Telefono nuovo' })
  assert.equal(body(await guest.call('GET', '/api/profile')).role, 'guest')
  r = await guest.call('GET', '/api/recovery/profiles')
  assert.deepEqual(body(r), { entries: [{ profileId: p.id, name: 'Bacca', device: phone.key, deviceName: 'REDMAGIC 10 Pro', updatedAt: 1000 }] })
  r = await guest.call('GET', '/api/recovery/' + p.id + '/' + phone.key)
  assert.deepEqual(body(r), { salt: first.salt, opslimit: 3, memlimit: 67108864 })
  r = await guest.call('GET', '/api/recovery/' + p.id + '/' + guest.key)
  assert.deepEqual(body(r), { error: 'Recupero non attivo', code: 'no_recovery' })
  const release = (dev, verifier) => dev.call('POST', '/api/recovery/' + p.id + '/' + phone.key + '/release', { body: { verifier } })
  r = await release(guest, secretPair().verifier)
  assert.equal(r.status, 403)
  assert.deepEqual(body(r), { error: 'Password errata', code: 'wrong_password', triesLeft: 4 })
  r = await release(guest, s.verifier)
  assert.deepEqual(body(r), { blob: first.blob, updatedAt: 1000 })
  assert.equal((await release(guest, 'zz')).status, 400)

  // Local callers have no device: no blob of their own.
  assert.equal((await request(app.ports.http, 'PUT', '/api/recovery', { body: first })).status, 403)
  // DELETE removes this device's blob.
  assert.deepEqual(body(await phone.call('DELETE', '/api/recovery')), { ok: true })
  assert.deepEqual(body(await guest.call('GET', '/api/recovery/profiles')), { entries: [] })
})

test('recovery: the 5th failure locks for 1 h even with the right verifier, then 2 h, then 4 h; a release or a PUT resets the doubling; the lock survives a restart', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  const P = '1'.repeat(32)
  const D = '2'.repeat(64)
  const s = secretPair()
  const wrong = Buffer.alloc(32, 9)
  let store = new RecoveryStore(dir)
  store.put(P, D, blobBody(s.verifierHash, 1), 'Telefono')
  let now = 1e12
  const fail = (n) => {
    let r
    for (let i = 0; i < n; i++) r = store.release(P, D, wrong, now)
    return r
  }
  assert.deepEqual(fail(4), { wrong: true, triesLeft: 1 })
  assert.deepEqual(fail(1), { locked: true, retryAt: now + HOUR })
  assert.deepEqual(store.release(P, D, Buffer.from(s.verifier, 'hex'), now + 1000), { locked: true, retryAt: now + HOUR }, 'locked even with the right verifier')

  // The lock is on disk: a restart keeps it.
  store = new RecoveryStore(dir)
  assert.equal(store.release(P, D, Buffer.from(s.verifier, 'hex'), now + 59 * 60000).locked, true)
  now += HOUR
  assert.deepEqual(fail(4), { wrong: true, triesLeft: 1 }, 'the old failures are out of the hour')
  assert.deepEqual(fail(1), { locked: true, retryAt: now + 2 * HOUR }, 'the next lock is two hours')
  now += 2 * HOUR
  assert.deepEqual(fail(5), { locked: true, retryAt: now + 4 * HOUR }, 'then four')
  now += 4 * HOUR
  const ok = store.release(P, D, Buffer.from(s.verifier, 'hex'), now)
  assert.equal(ok.ok, true)
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'recovery', P + '.json'), 'utf8')).locks, 0, 'a release resets the doubling')
  assert.deepEqual(fail(4), { wrong: true, triesLeft: 1 }, 'failures are kept by a release')
  now += HOUR + 1
  assert.deepEqual(fail(5), { locked: true, retryAt: now + HOUR }, 'back to one hour')
  store.put(P, D, blobBody(s.verifierHash, 2), 'Telefono')
  const rec = JSON.parse(fs.readFileSync(path.join(dir, 'recovery', P + '.json'), 'utf8'))
  assert.deepEqual([rec.failures, rec.lockedUntil, rec.locks], [[], 0, 0], 'a PUT resets failures, lock and locks')
  // At most 30 days.
  for (let i = 0; i < 12; i++) {
    now += 31 * 24 * HOUR
    fail(5)
  }
  const last = JSON.parse(fs.readFileSync(path.join(dir, 'recovery', P + '.json'), 'utf8'))
  assert.equal(last.lockedUntil - now, 30 * 24 * HOUR)
})

test('recovery over HTTP: 429 locked with retryAt', async (t) => {
  const c = cleanup(t)
  const app = c.close(await createMPfy({ dataDir: c.dir(tmpDir()), port: 0, adminPort: 0, p2p: false, ffmpeg: null, fpcalc: null, sevenZip: null, whoIs: testWhoIs }))
  const p = makeProfile()
  const phone = device(app, { profile: p })
  const s = secretPair()
  await phone.call('PUT', '/api/recovery', { body: blobBody(s.verifierHash) })
  const guest = device(app)
  let r
  for (let i = 0; i < 5; i++) r = await guest.call('POST', '/api/recovery/' + p.id + '/' + phone.key + '/release', { body: { verifier: '0'.repeat(64) } })
  assert.equal(r.status, 429)
  assert.equal(body(r).code, 'locked')
  assert.equal(body(r).error, 'Troppi tentativi')
  assert.ok(body(r).retryAt > Date.now() + 59 * 60000)
  r = await guest.call('POST', '/api/recovery/' + p.id + '/' + phone.key + '/release', { body: { verifier: s.verifier } })
  assert.equal(r.status, 429)
})
