// The profile photo on a source: the store (time rules like the name's, the file
// on disk always there for the record that names it, the sweep at load, records
// from before photos) and the API (GET/HEAD/PUT /api/profile/photo, the photo in
// GET /api/profile, only ever the caller's own).

import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createMPfy } from '../server/app.mjs'
import { ProfilesStore, validPhoto, MAX_PHOTO_BYTES } from '../server/profiles.mjs'
import { tmpDir, cleanup, request, json, makeProfile, device, testWhoIs, fakeJpeg } from './helpers.mjs'

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
const photosIn = (dir) => {
  try {
    return fs.readdirSync(path.join(dir, 'profile-photos')).sort()
  } catch {
    return []
  }
}
const fileOf = (id, bytes) => id + '-' + sha(bytes) + '.jpg'
// A photo whose hash sorts above (or below) that of `than`.
const beside = (than, above) => {
  for (let seed = 100; ; seed++) {
    const bytes = fakeJpeg(seed)
    if ((sha(bytes) > sha(than)) === above) return bytes
  }
}

async function start (t, opts = {}) {
  const c = cleanup(t)
  const dir = opts.dir || c.dir(tmpDir())
  const app = c.close(await createMPfy({
    dataDir: dir, port: 0, adminPort: 0, p2p: false, debounceMs: 10, ffmpeg: null, fpcalc: null, sevenZip: null, whoIs: testWhoIs, ...opts
  }))
  return { app, dir, port: app.ports.http }
}

function store (t) {
  const dir = cleanup(t).dir(tmpDir())
  const s = new ProfilesStore(dir)
  const p = makeProfile()
  s.create(p.id, p.signPublicKey.toString('hex'), 1000)
  return { s, dir, id: p.id }
}

test('photo bytes: 1 to 48 KB, FF D8 FF in front and FF D9 at the end', () => {
  assert.equal(validPhoto(fakeJpeg(1, 20000)), true)
  assert.equal(validPhoto(fakeJpeg(1, MAX_PHOTO_BYTES)), true, 'exactly 48 KB')
  assert.equal(validPhoto(fakeJpeg(1, MAX_PHOTO_BYTES + 1)), false, 'one byte more')
  assert.equal(validPhoto(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), true, 'the shortest that fits the rule')
  assert.equal(validPhoto(Buffer.alloc(0)), false)
  assert.equal(validPhoto(Buffer.from([0xff])), false)
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(100), Buffer.from([0xff, 0xd9])])
  assert.equal(validPhoto(png), false, 'a PNG')
  const cut = fakeJpeg(2).subarray(0, 1000)
  assert.equal(validPhoto(cut), false, 'cut short: no FF D9 at the end')
  assert.equal(validPhoto('ffd8ffd9'), false)
  assert.equal(validPhoto(null), false)
})

test('store: newer times only (older, equal, too far ahead refused), the file follows the record, a removal is a change with its own time', (t) => {
  const { s, dir, id } = store(t)
  const now = 1000000
  const one = fakeJpeg(1)
  const two = fakeJpeg(2)
  assert.deepEqual([s.get(id).photo, s.get(id).photoUpdatedAt], [null, 0], 'a new record has none')
  assert.equal(s.photoFile(id), null)

  assert.equal(s.setPhoto(id, one, 100, now), true)
  assert.deepEqual([s.get(id).photo, s.get(id).photoUpdatedAt], [sha(one), 100])
  assert.equal(s.photoFile(id), path.join(dir, 'profile-photos', fileOf(id, one)))
  assert.ok(path.isAbsolute(s.photoFile(id)))
  assert.ok(fs.readFileSync(s.photoFile(id)).equals(one))
  assert.deepEqual(photosIn(dir), [fileOf(id, one)])

  assert.equal(s.setPhoto(id, two, 99, now), false, 'older')
  assert.equal(s.setPhoto(id, beside(one, false), 100, now), false, 'the same time with a lower hash')
  assert.equal(s.setPhoto(id, one, 100, now), false, 'the same photo at the same time')
  assert.equal(s.setPhoto(id, two, now + 5 * 60 * 1000 + 1, now), false, 'more than 5 minutes ahead')
  assert.equal(s.setPhoto(id, null, 100, now), false, 'a removal with the same time')
  assert.equal(s.get(id).photo, sha(one))
  assert.deepEqual(photosIn(dir), [fileOf(id, one)], 'nothing written for a refused change')

  assert.equal(s.setPhoto(id, two, now + 5 * 60 * 1000, now), true, 'exactly 5 minutes ahead is fine')
  assert.equal(s.get(id).photo, sha(two))
  assert.deepEqual(photosIn(dir), [fileOf(id, two)], 'the old file went once the record moved on')
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'profiles.json'), 'utf8')).profiles[0]
  assert.deepEqual([onDisk.photo, onDisk.photoUpdatedAt], [sha(two), now + 5 * 60 * 1000])

  // The same photo again with a newer time: kept, its one file too.
  assert.equal(s.setPhoto(id, two, now + 5 * 60 * 1000 + 1, now + 1), true)
  assert.deepEqual(photosIn(dir), [fileOf(id, two)])

  // A removal is a change like any other: newer only, and its file goes.
  assert.equal(s.setPhoto(id, null, now + 5 * 60 * 1000 + 2, now + 2), true)
  assert.deepEqual([s.get(id).photo, s.get(id).photoUpdatedAt], [null, now + 5 * 60 * 1000 + 2])
  assert.equal(s.photoFile(id), null)
  assert.deepEqual(photosIn(dir), [])
  assert.equal(s.setPhoto(id, one, now + 5 * 60 * 1000 + 1, now + 3), false, 'a photo older than the removal')

  assert.equal(s.setPhoto('f'.repeat(32), one, 5, now), false, 'an unknown profile')
  assert.throws(() => s.setPhoto(id, Buffer.from('nope'), now + 5 * 60 * 1000 + 3, now + 3), /not a valid photo/)
  assert.equal(new ProfilesStore(dir).get(id).photoUpdatedAt, now + 5 * 60 * 1000 + 2, 'read back from the file')
})

test('store: a record never points to a missing file, whether the photo file or the record cannot be written', (t) => {
  const { s, dir, id } = store(t)
  const one = fakeJpeg(1)
  const two = fakeJpeg(2)
  assert.equal(s.setPhoto(id, one, 10), true)

  // The new file cannot be written (its temporary name is taken by a folder):
  // the record still names the old one, which is still there.
  const tmpOfTwo = path.join(dir, 'profile-photos', fileOf(id, two) + '.tmp')
  fs.mkdirSync(tmpOfTwo)
  assert.throws(() => s.setPhoto(id, two, 20))
  assert.deepEqual([s.get(id).photo, s.get(id).photoUpdatedAt], [sha(one), 10])
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'profiles.json'), 'utf8')).profiles[0].photo, sha(one))
  assert.ok(fs.readFileSync(s.photoFile(id)).equals(one))
  fs.rmdirSync(tmpOfTwo)

  // The record cannot be written (profiles.json does not parse: never written
  // over): the old file stays, the new one goes, nothing moved.
  const file = path.join(dir, 'profiles.json')
  const good = fs.readFileSync(file, 'utf8')
  fs.writeFileSync(file, good.replace(/]\s*}\s*$/, ',]}'))
  assert.throws(() => s.setPhoto(id, two, 20), /non leggibile/)
  assert.deepEqual([s.get(id).photo, s.get(id).photoUpdatedAt], [sha(one), 10])
  assert.ok(fs.readFileSync(s.photoFile(id)).equals(one), 'the file the record names is still there')
  assert.deepEqual(photosIn(dir), [fileOf(id, one)], 'and the new one is gone')
  assert.throws(() => s.setPhoto(id, null, 20), /non leggibile/)
  assert.ok(fs.existsSync(s.photoFile(id)), 'a removal that could not be recorded keeps the file')
  fs.writeFileSync(file, good)
  assert.equal(s.setPhoto(id, two, 20), true, 'fixed by hand: it works again')
  assert.deepEqual(photosIn(dir), [fileOf(id, two)])
})

test('store: on the very same time the greater hash wins, none below any photo, so devices that changed it in one millisecond end on one photo', (t) => {
  const { s, dir, id } = store(t)
  const one = fakeJpeg(1)
  assert.equal(s.setPhoto(id, one, 100, 1000), true)
  assert.equal(s.setPhoto(id, beside(one, false), 100, 1000), false, 'a lower hash')
  assert.equal(s.setPhoto(id, one, 100, 1000), false, 'the same photo')
  assert.equal(s.setPhoto(id, null, 100, 1000), false, 'a removal')
  assert.deepEqual([s.get(id).photo, s.get(id).photoUpdatedAt], [sha(one), 100])
  const higher = beside(one, true)
  assert.equal(s.setPhoto(id, higher, 100, 1000), true, 'a greater hash')
  assert.deepEqual([s.get(id).photo, s.get(id).photoUpdatedAt], [sha(higher), 100])
  assert.deepEqual(photosIn(dir), [fileOf(id, higher)])
  assert.equal(s.setPhoto(id, null, 101, 1000), true)
  assert.equal(s.setPhoto(id, null, 101, 1000), false, 'no photo over no photo')
  assert.equal(s.setPhoto(id, one, 101, 1000), true, 'any photo over a removal at the same time')
  assert.equal(s.get(id).photo, sha(one))
})

// A device downloading the photo: its file held open the way sendFile opens it.
async function reader (t, file) {
  const stream = fs.createReadStream(file, { highWaterMark: 1 })
  await new Promise((resolve, reject) => {
    stream.once('open', resolve)
    stream.once('error', reject)
  })
  t.after(() => stream.destroy())
  return stream
}

test('store: a device still downloading a photo never holds back a change: the same photo again, back to the previous one, a removal; no temporary file left', async (t) => {
  const { s, dir, id } = store(t)
  // A file moved out of the way while someone reads it keeps a gone-* name until
  // the reader lets go (Windows); no record names it, the next load sweeps it.
  const named = () => photosIn(dir).filter((n) => !n.startsWith('gone-'))
  const one = fakeJpeg(1)
  const two = fakeJpeg(2)
  assert.equal(s.setPhoto(id, one, 10), true)
  await reader(t, s.photoFile(id))
  assert.equal(s.setPhoto(id, one, 20), true, 'the same photo with a newer time')
  assert.deepEqual([s.get(id).photo, s.get(id).photoUpdatedAt], [sha(one), 20])
  assert.deepEqual(named(), [fileOf(id, one)])
  assert.equal(s.setPhoto(id, two, 30), true)
  assert.deepEqual(named(), [fileOf(id, two)], 'the old file is out of the way at once')
  await reader(t, s.photoFile(id))
  assert.equal(s.setPhoto(id, one, 40), true, 'back to the photo still being read')
  assert.deepEqual(named(), [fileOf(id, one)])
  assert.ok(fs.readFileSync(s.photoFile(id)).equals(one))
  assert.equal(s.setPhoto(id, null, 50), true)
  assert.deepEqual(named(), [])
  assert.equal(s.setPhoto(id, two, 60), true, 'and the name of one being read is free again')
  assert.ok(fs.readFileSync(s.photoFile(id)).equals(two))
  assert.deepEqual(named(), [fileOf(id, two)])

  // A photo file that cannot take its name leaves no temporary file behind.
  const three = fakeJpeg(3)
  const blocked = path.join(dir, 'profile-photos', fileOf(id, three))
  fs.mkdirSync(blocked)
  fs.writeFileSync(path.join(blocked, 'x'), 'x')
  assert.throws(() => s.setPhoto(id, three, 70))
  assert.deepEqual([s.get(id).photo, s.get(id).photoUpdatedAt], [sha(two), 60])
  assert.deepEqual(named(), [fileOf(id, three), fileOf(id, two)].sort(), 'no .tmp left')
})

test('store: markRemoved deletes the photo; the sweep at load removes what no record names, never while profiles.json is unreadable; records from before photos', (t) => {
  const { s, dir, id } = store(t)
  const other = makeProfile()
  s.create(other.id, other.signPublicKey.toString('hex'))
  const one = fakeJpeg(1)
  const mine = fakeJpeg(3)
  assert.equal(s.setPhoto(id, one, 10), true)
  assert.equal(s.setPhoto(other.id, mine, 10), true)
  assert.equal(s.markRemoved(id, 50), true)
  assert.equal(s.get(id).photo, null)
  assert.equal(s.photoFile(id), null)
  assert.deepEqual(photosIn(dir), [fileOf(other.id, mine)], 'the removed profile\'s file went, the other stays')
  assert.equal(s.setPhoto(id, one, 60), false, 'a removed profile takes no photo')

  // Left behind: an old photo, a temporary file, a photo of the removed profile.
  const pd = path.join(dir, 'profile-photos')
  const leftovers = [fileOf(other.id, one), fileOf(other.id, mine) + '.tmp', fileOf(id, one), 'x.jpg']
  for (const name of leftovers) fs.writeFileSync(path.join(pd, name), 'x')
  const file = path.join(dir, 'profiles.json')
  const good = fs.readFileSync(file, 'utf8')
  fs.writeFileSync(file, good.replace(/]\s*}\s*$/, ',]}'))
  assert.equal(new ProfilesStore(dir).photoFile(other.id), null, 'unreadable: no record known')
  assert.deepEqual(photosIn(dir), [...leftovers, fileOf(other.id, mine)].sort(), 'unreadable: nothing swept')
  fs.writeFileSync(file, good)
  const again = new ProfilesStore(dir)
  assert.deepEqual(photosIn(dir), [fileOf(other.id, mine)], 'only the file a record names is left')
  assert.ok(fs.readFileSync(again.photoFile(other.id)).equals(mine))

  // A profiles.json from before photos: none, at time 0; unknown fields kept.
  const oldDir = cleanup(t).dir(tmpDir())
  const p = makeProfile()
  fs.writeFileSync(path.join(oldDir, 'profiles.json'), JSON.stringify({ schema: 1, profiles: [{ profileId: p.id, signPublicKey: p.signPublicKey.toString('hex'), name: 'Bacca', nameUpdatedAt: 5, createdAt: 1, lastSeenAt: 1, removedAt: null, extra: 'kept' }] }))
  const old = new ProfilesStore(oldDir)
  assert.deepEqual([old.get(p.id).photo, old.get(p.id).photoUpdatedAt], [null, 0])
  assert.equal(old.photoFile(p.id), null)
  assert.equal(old.setPhoto(p.id, one, 1), true, 'any first time is newer than 0')
  const rec = JSON.parse(fs.readFileSync(path.join(oldDir, 'profiles.json'), 'utf8')).profiles[0]
  assert.deepEqual([rec.name, rec.photo, rec.photoUpdatedAt, rec.extra], ['Bacca', sha(one), 1, 'kept'])
  // Values that are not a photo hash or a time read as none.
  fs.writeFileSync(path.join(oldDir, 'profiles.json'), JSON.stringify({ schema: 1, profiles: [{ ...rec, photo: 'ABC', photoUpdatedAt: 'ieri' }] }))
  const odd = new ProfilesStore(oldDir)
  assert.deepEqual([odd.get(p.id).photo, odd.get(p.id).photoUpdatedAt], [null, 0])
  assert.deepEqual(photosIn(oldDir), [], 'and its file, named by no record now, swept')
})

test('API: PUT, GET, HEAD /api/profile/photo, 304, 404; the photo and its time in GET /api/profile; an older time answers the profile as it is', async (t) => {
  const { app, dir } = await start(t)
  const p = makeProfile()
  const phone = device(app, { profile: p })
  let r = await phone.call('GET', '/api/profile')
  assert.deepEqual([json(r).photo, json(r).photoUpdatedAt], [null, 0])
  r = await phone.call('GET', '/api/profile/photo')
  assert.equal(r.status, 404, 'none yet')
  assert.equal(json(r).error, 'Foto non trovata')

  const one = fakeJpeg(1)
  r = await phone.call('PUT', '/api/profile/photo', { body: { photo: one.toString('base64'), photoUpdatedAt: 1000 } })
  assert.equal(r.status, 200, r.body.toString())
  assert.deepEqual([json(r).profileId, json(r).photo, json(r).photoUpdatedAt], [p.id, sha(one), 1000])
  assert.deepEqual(photosIn(dir), [fileOf(p.id, one)])

  r = await phone.call('GET', '/api/profile/photo')
  assert.equal(r.status, 200)
  assert.ok(r.body.equals(one))
  assert.equal(r.headers['content-type'], 'image/jpeg')
  assert.equal(r.headers.etag, '"' + sha(one) + '"')
  assert.equal(r.headers['cache-control'], 'no-cache')
  assert.equal(Number(r.headers['content-length']), one.length)
  r = await phone.call('GET', '/api/profile/photo', { headers: { 'if-none-match': '"' + sha(one) + '"' } })
  assert.equal(r.status, 304)
  assert.equal(r.body.length, 0)
  r = await phone.call('GET', '/api/profile/photo', { headers: { 'if-none-match': '"' + sha(fakeJpeg(9)) + '"' } })
  assert.equal(r.status, 200, 'another tag gets the bytes')
  r = await phone.call('HEAD', '/api/profile/photo')
  assert.equal(r.status, 200)
  assert.equal(r.body.length, 0)
  assert.equal(Number(r.headers['content-length']), one.length)
  assert.equal(r.headers.etag, '"' + sha(one) + '"')

  // Older, or the same time with a lower hash: 200 with what the source keeps.
  const two = fakeJpeg(2)
  for (const [bytes, at] of [[two, 999], [beside(one, false), 1000], [one, 1000]]) {
    r = await phone.call('PUT', '/api/profile/photo', { body: { photo: bytes.toString('base64'), photoUpdatedAt: at } })
    assert.equal(r.status, 200)
    assert.deepEqual([json(r).photo, json(r).photoUpdatedAt], [sha(one), 1000], 'time ' + at)
  }
  // The same time with a greater hash wins.
  const higher = beside(one, true)
  r = await phone.call('PUT', '/api/profile/photo', { body: { photo: higher.toString('base64'), photoUpdatedAt: 1000 } })
  assert.deepEqual([json(r).photo, json(r).photoUpdatedAt], [sha(higher), 1000])
  assert.deepEqual(photosIn(dir), [fileOf(p.id, higher)])
  r = await phone.call('PUT', '/api/profile/photo', { body: { photo: two.toString('base64'), photoUpdatedAt: 2000 } })
  assert.equal(json(r).photo, sha(two))
  assert.ok((await phone.call('GET', '/api/profile/photo')).body.equals(two))
  assert.deepEqual(photosIn(dir), [fileOf(p.id, two)])

  // Removed: 404 afterwards, nothing on disk.
  r = await phone.call('PUT', '/api/profile/photo', { body: { photo: null, photoUpdatedAt: 3000 } })
  assert.deepEqual([json(r).photo, json(r).photoUpdatedAt], [null, 3000])
  assert.equal((await phone.call('GET', '/api/profile/photo')).status, 404)
  assert.equal((await phone.call('HEAD', '/api/profile/photo')).status, 404)
  assert.deepEqual(photosIn(dir), [])
  const view = json(await phone.call('GET', '/api/profile'))
  assert.deepEqual([view.photo, view.photoUpdatedAt], [null, 3000])

  // The largest photo there is (48 KB, 64 KB of base64) goes through and back.
  const big = fakeJpeg(5, MAX_PHOTO_BYTES)
  r = await phone.call('PUT', '/api/profile/photo', { body: { photo: big.toString('base64'), photoUpdatedAt: 4000 } })
  assert.equal(r.status, 200, r.body.toString())
  assert.equal(json(r).photo, sha(big))
  r = await phone.call('GET', '/api/profile/photo')
  assert.equal(r.status, 200)
  assert.ok(r.body.equals(big))
})

test('API: bad_photo (not a JPEG, too big, empty, bad base64, missing), a missing time, too large a body, no_profile; nothing stored', async (t) => {
  const { app, dir, port } = await start(t)
  const p = makeProfile()
  const phone = device(app, { profile: p })
  const now = Date.now()
  const b64 = (b) => b.toString('base64')
  const bad = [
    [{ photo: b64(Buffer.from('<html>no</html>')), photoUpdatedAt: now }, 'not a JPEG'],
    [{ photo: b64(fakeJpeg(1, MAX_PHOTO_BYTES + 1)), photoUpdatedAt: now }, 'one byte over 48 KB'],
    [{ photo: '', photoUpdatedAt: now }, 'empty'],
    [{ photo: '***', photoUpdatedAt: now }, 'not base64'],
    [{ photo: b64(fakeJpeg(1)).slice(0, -1), photoUpdatedAt: now }, 'base64 without its padding'],
    [{ photo: b64(fakeJpeg(1)).replace(/=+$/, '') + ' ', photoUpdatedAt: now }, 'a space in it'],
    [{ photoUpdatedAt: now }, 'missing'],
    [{ photo: 7, photoUpdatedAt: now }, 'a number']
  ]
  for (const [body, what] of bad) {
    const r = await phone.call('PUT', '/api/profile/photo', { body })
    assert.equal(r.status, 400, what)
    assert.deepEqual(json(r), { error: 'Foto non valida', code: 'bad_photo' }, what)
  }
  for (const at of [undefined, 'adesso', null]) {
    const r = await phone.call('PUT', '/api/profile/photo', { body: { photo: b64(fakeJpeg(1)), photoUpdatedAt: at } })
    assert.equal(r.status, 400, String(at))
    assert.equal(json(r).error, 'Momento non valido')
  }
  const huge = await phone.call('PUT', '/api/profile/photo', { body: { photo: 'A'.repeat(200 * 1024), photoUpdatedAt: now } })
  assert.equal(huge.status, 413)
  assert.equal(app.profiles.get(p.id).photo, null)
  assert.equal(app.profiles.get(p.id).photoUpdatedAt, 0)
  assert.deepEqual(photosIn(dir), [])

  // Without a profile (the source itself, from 127.0.0.1): none to set, none to read.
  let r = await request(port, 'PUT', '/api/profile/photo', { body: { photo: b64(fakeJpeg(1)), photoUpdatedAt: now } })
  assert.equal(r.status, 403)
  assert.deepEqual(json(r), { error: 'Profilo mancante', code: 'no_profile' })
  r = await request(port, 'GET', '/api/profile/photo')
  assert.equal(r.status, 404)
  assert.deepEqual([json(await request(port, 'GET', '/api/profile')).photo, json(await request(port, 'GET', '/api/profile')).photoUpdatedAt], [null, 0])
  assert.equal((await phone.call('DELETE', '/api/profile/photo')).status, 404, 'no other method')
  assert.equal((await phone.call('POST', '/api/profile/photo', { body: {} })).status, 404)
})

test('API: only the caller\'s own photo; a guest gets nothing; a removed profile\'s photo goes', async (t) => {
  const { app, dir } = await start(t)
  app.people.openClaim(30)
  const owner = device(app, { profile: makeProfile(), name: 'Bacca' })
  assert.equal(json(await owner.call('GET', '/api/profile')).role, 'owner')
  const sara = device(app, { profile: makeProfile(), name: 'Sara' })
  const saraPc = device(app, { profile: sara.profile, name: 'PC di Sara' })
  const one = fakeJpeg(1)
  assert.equal((await sara.call('PUT', '/api/profile/photo', { body: { photo: one.toString('base64'), photoUpdatedAt: 10 } })).status, 200)
  assert.ok((await saraPc.call('GET', '/api/profile/photo')).body.equals(one), 'her other device reads it')
  const r = await owner.call('GET', '/api/profile/photo')
  assert.equal(r.status, 404, 'even the owner never reads another profile\'s')
  assert.equal(json(await owner.call('GET', '/api/profile')).photo, null)
  const mine = fakeJpeg(2)
  await owner.call('PUT', '/api/profile/photo', { body: { photo: mine.toString('base64'), photoUpdatedAt: 10 } })
  assert.ok((await owner.call('GET', '/api/profile/photo')).body.equals(mine))
  assert.ok((await sara.call('GET', '/api/profile/photo')).body.equals(one), 'each their own')
  // A profile header naming another profile is refused before anything is read.
  const other = await sara.call('GET', '/api/profile/photo', { headers: { 'x-mpfy-profile': owner.profile.id } })
  assert.equal(other.status, 403)

  // A guest (a device without a profile) gets none of it.
  const guest = device(app, { name: 'Nuovo telefono' })
  assert.equal(json(await guest.call('GET', '/api/profile')).role, 'guest')
  for (const [method, body] of [['GET', null], ['HEAD', null], ['PUT', { photo: one.toString('base64'), photoUpdatedAt: 20 }]]) {
    const res = await guest.call(method, '/api/profile/photo', { body })
    assert.equal(res.status, 403, method)
    if (method !== 'HEAD') assert.deepEqual(json(res), { error: 'Profilo mancante', code: 'no_profile' }, method)
  }

  // Sara is removed: her photo file goes with her.
  assert.equal((await owner.call('DELETE', '/api/admin/profiles/' + sara.profile.id)).status, 200)
  assert.deepEqual(photosIn(dir), [fileOf(owner.profile.id, mine)])
})
