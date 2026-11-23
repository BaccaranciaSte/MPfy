// Playlist edits over HTTP from two devices that do not see each other's changes at once: an
// order sent with the list it was made from (base), and removals sent with the ids seen.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createMPfy } from '../server/app.mjs'
import { tmpDir, cleanup, request, json, makeWav } from './helpers.mjs'

async function start (t) {
  const c = cleanup(t)
  const app = c.close(await createMPfy({ dataDir: c.dir(tmpDir()), port: 0, adminPort: 0, p2p: false, debounceMs: 10, ffmpeg: null, fpcalc: null, sevenZip: null }))
  const port = app.ports.http
  const call = async (method, p, body) => {
    const r = await request(port, method, p, body === undefined ? {} : { body })
    return { status: r.status, data: r.body.length ? json(r) : null }
  }
  const ids = []
  for (let i = 0; i < 4; i++) ids.push((await call('PUT', '/api/upload/t' + i + '.wav', makeWav({ freq: 300 + i * 50, seconds: 1 }))).data.track.id)
  return { call, ids }
}

test('http: a removal with the ids seen, from a device behind the list, removes the song it showed', async (t) => {
  const { call, ids } = await start(t)
  const [a, b, c, d] = ids
  const pl = (await call('POST', '/api/playlists', { name: 'Due telefoni' })).data.playlist
  await call('POST', '/api/playlists/' + pl.id + '/tracks', { trackIds: [a, b, c, d] })
  await call('DELETE', '/api/playlists/' + pl.id + '/tracks', { indexes: [0], ids: [a] })
  const r = await call('DELETE', '/api/playlists/' + pl.id + '/tracks', { indexes: [2], ids: [c] })
  assert.equal(r.status, 200)
  assert.deepEqual(r.data.playlist.trackIds, [b, d])
  const bad = await call('DELETE', '/api/playlists/' + pl.id + '/tracks', { indexes: [0], ids: [b, d] })
  assert.equal(bad.status, 400)
})

test('http: an order made from an older list keeps a song another device added meanwhile', async (t) => {
  const { call, ids } = await start(t)
  const [a, b, c, d] = ids
  const pl = (await call('POST', '/api/playlists', { name: 'Riordino' })).data.playlist
  await call('POST', '/api/playlists/' + pl.id + '/tracks', { trackIds: [a, b, c] })
  await call('POST', '/api/playlists/' + pl.id + '/tracks', { trackIds: [d] })
  const r = await call('PATCH', '/api/playlists/' + pl.id, { trackIds: [c, a, b], base: [a, b, c] })
  assert.equal(r.status, 200)
  assert.deepEqual(r.data.playlist.trackIds, [c, a, b, d])
  const lib = (await call('GET', '/api/library')).data
  assert.deepEqual(lib.playlists.find((p) => p.id === pl.id).trackIds, [c, a, b, d])
})

test('http: a removal says how many copies it saw; a copy already gone is not taken twice', async (t) => {
  const { call, ids } = await start(t)
  const [a, b] = ids
  const pl = (await call('POST', '/api/playlists', { name: 'Doppio' })).data.playlist
  await call('POST', '/api/playlists/' + pl.id + '/tracks', { trackIds: [a, b, a] })
  await call('DELETE', '/api/playlists/' + pl.id + '/tracks', { indexes: [0], ids: [a], counts: [2] })
  const r = await call('DELETE', '/api/playlists/' + pl.id + '/tracks', { indexes: [0], ids: [a], counts: [2] })
  assert.equal(r.status, 200)
  assert.deepEqual(r.data.playlist.trackIds, [b, a])
  const bad = await call('DELETE', '/api/playlists/' + pl.id + '/tracks', { indexes: [0], ids: [b], counts: [0] })
  assert.equal(bad.status, 400)
})
