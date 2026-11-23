// Path validation and request guards: nothing from a request may reach a file
// outside what the server means to serve.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createMPfy } from '../server/app.mjs'
import { isTrackId, isCoverId, isPlaylistId, isPublicKey, trackFileName, cleanUploadName, titleFromFileName } from '../server/ids.mjs'
import { makeWav, tmpDir, rmDir, request, json, treeFiles } from './helpers.mjs'

test('ids: strict formats only', () => {
  assert.ok(isTrackId('0123456789abcdef01234567'))
  for (const bad of ['0123456789ABCDEF01234567', '0123456789abcdef0123456', '0123456789abcdef012345678', '../../../../etc/passwd', '0123456789abcdef0123456/', '', null, 5]) {
    assert.equal(isTrackId(bad), false, String(bad))
  }
  assert.ok(isCoverId('a'.repeat(24)))
  assert.equal(isCoverId('a'.repeat(23) + '.'), false)
  assert.ok(isPlaylistId('0123456789abcdef'))
  assert.equal(isPlaylistId('0123456789abcdeg'), false)
  assert.ok(isPublicKey('f'.repeat(64)))
  assert.equal(isPublicKey('f'.repeat(63)), false)
})

test('ids: file names come from validated ids and fixed extensions', () => {
  assert.equal(trackFileName({ id: 'a'.repeat(24), format: 'flac' }), 'a'.repeat(24) + '.flac')
  assert.throws(() => trackFileName({ id: '../x', format: 'mp3' }))
  assert.throws(() => trackFileName({ id: 'a'.repeat(24), format: '../../x' }))
  assert.throws(() => trackFileName({ id: 'a'.repeat(24), format: 'exe' }))
})

test('ids: upload names are reduced to a display string', () => {
  assert.equal(cleanUploadName('../../etc/passwd'), 'passwd')
  assert.equal(cleanUploadName('..\\..\\win.ini'), 'win.ini')
  assert.equal(cleanUploadName('a\u0000b\u202ec.mp3'), 'abc.mp3')
  assert.equal(titleFromFileName('Canzone.del.mare.mp3', 'x'), 'Canzone.del.mare')
  assert.equal(titleFromFileName('.mp3', 'fallback'), '.mp3')
  assert.equal(titleFromFileName('', 'fallback'), 'fallback')
})

async function start (t) {
  // Data dir with the web dir inside it: "../keys.json" seen from web/ is the real thing.
  const dir = tmpDir()
  const web = path.join(dir, 'web')
  fs.mkdirSync(web)
  fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><title>MPfy</title>')
  fs.writeFileSync(path.join(web, 'app.js'), 'console.log(1)\n'.repeat(200))
  fs.writeFileSync(path.join(web, '.secret'), 'dotfile')
  const app = await createMPfy({ dataDir: dir, webDir: web, port: 0, adminPort: 0, p2p: false, debounceMs: 20, ffmpeg: null })
  t.after(async () => {
    await app.close()
    rmDir(dir)
  })
  const seed = JSON.parse(fs.readFileSync(path.join(dir, 'keys.json'), 'utf8')).seed
  return { app, dir, port: app.ports.http, admin: app.ports.admin, seed }
}

test('paths: both ports listen on 127.0.0.1 only', async (t) => {
  const { app } = await start(t)
  assert.equal(app.addresses.http.address, '127.0.0.1')
  assert.equal(app.addresses.admin.address, '127.0.0.1')
})

test('paths: traversal attempts never leave web/ or the data layout', async (t) => {
  const { port, seed } = await start(t)
  const attempts = [
    '/../keys.json',
    '/%2e%2e/keys.json',
    '/..%2fkeys.json',
    '/..%5ckeys.json',
    '/%2e%2e%5ckeys.json',
    '/web/../../keys.json',
    '//keys.json',
    '/.secret',
    '/api/../keys.json',
    '/api/stream/..%2f..%2fkeys.json',
    '/api/stream/%2e%2e',
    '/api/cover/..%2fkeys.json',
    '/api/cover/' + 'a'.repeat(24) + '%00',
    '/api/likes/..%2f..%2fkeys.json'
  ]
  for (const p of attempts) {
    const r = await request(port, 'GET', p)
    const text = r.body.toString('utf8')
    assert.ok(!text.includes(seed), p + ' leaked keys.json')
    assert.ok(!text.includes('dotfile'), p + ' served a dotfile')
    assert.ok([200, 400, 404].includes(r.status), p + ' -> ' + r.status)
    if (r.status === 200) assert.match(text, /<title>MPfy<\/title>/, p + ' should fall back to index.html')
  }
  const bad = await request(port, 'GET', '/%E0%A4%A')
  assert.equal(bad.status, 400)
})

test('paths: static files, SPA fallback, gzip and ETag', async (t) => {
  const { port } = await start(t)
  const js = await request(port, 'GET', '/app.js', { headers: { 'accept-encoding': 'gzip' } })
  assert.equal(js.status, 200)
  assert.equal(js.headers['content-type'], 'text/javascript; charset=utf-8')
  assert.equal(js.headers['cache-control'], 'no-cache')
  assert.equal(js.headers['content-encoding'], 'gzip')
  const again = await request(port, 'GET', '/app.js', { headers: { 'if-none-match': js.headers.etag } })
  assert.equal(again.status, 304)
  const spa = await request(port, 'GET', '/libreria/playlist/abc')
  assert.equal(spa.status, 200)
  assert.match(spa.headers['content-type'], /text\/html/)
  const post = await request(port, 'POST', '/index.html', { body: {} })
  assert.equal(post.status, 405)
})

test('paths: an upload name with path parts only becomes a title', async (t) => {
  const { app, dir, port } = await start(t)
  const r = await request(port, 'PUT', '/api/upload/..%2F..%2Fevil.wav', { body: makeWav({ freq: 777 }) })
  assert.equal(r.status, 200)
  const { track } = json(r)
  assert.equal(track.title, 'evil')
  assert.ok(!fs.existsSync(path.join(dir, '..', 'evil.wav')))
  assert.ok(!fs.existsSync(path.join(dir, 'evil.wav')))
  assert.deepEqual(treeFiles(dir, 'library'), [track.id + '.wav'])
  assert.equal(app.library.tracks.size, 1)
})

test('guards: foreign Host (DNS rebinding) and foreign Origin (CSRF) are refused', async (t) => {
  const { port, admin } = await start(t)
  let r = await request(port, 'GET', '/api/health', { headers: { host: 'evil.example:' + port } })
  assert.equal(r.status, 403)
  r = await request(port, 'GET', '/api/health', { headers: { host: 'localhost:47123' } })
  assert.equal(r.status, 200)
  r = await request(port, 'POST', '/api/playlists', { body: { name: 'x' }, headers: { origin: 'http://evil.example' } })
  assert.equal(r.status, 403)
  r = await request(port, 'POST', '/api/playlists', { body: { name: 'x' }, headers: { origin: 'null' } })
  assert.equal(r.status, 403)
  r = await request(port, 'POST', '/api/playlists', { body: { name: 'x' }, headers: { origin: 'http://127.0.0.1:47123' } })
  assert.equal(r.status, 200)
  r = await request(port, 'POST', '/api/admin/code/rotate', { headers: { origin: 'http://evil.example' } })
  assert.equal(r.status, 403, 'a page elsewhere cannot rotate the pairing code')
  r = await request(port, 'DELETE', '/api/admin/clients/self', { headers: { origin: 'http://evil.example' } })
  assert.equal(r.status, 403)
  r = await request(port, 'GET', '/api/admin/code', { headers: { host: 'evil.example' } })
  assert.equal(r.status, 403, 'DNS rebinding cannot read the pairing code')
  r = await request(admin, 'POST', '/admin/health', { headers: { origin: 'http://evil.example' } })
  assert.equal(r.status, 403)
  r = await request(admin, 'GET', '/admin/health', { headers: { host: 'evil.example' } })
  assert.equal(r.status, 403)
})

test('admin: 8092 keeps only health; the client API lives under /api/admin (local request, no P2P)', async (t) => {
  const { app, admin, port } = await start(t)
  const h = json(await request(admin, 'GET', '/admin/health'))
  assert.equal(h.ok, true)
  assert.match(h.serverPublicKey, /^[0-9a-f]{64}$/)
  assert.equal(h.clients, 0)
  assert.equal(h.p2p, false)
  assert.equal(h.media.ffmpeg, false)
  for (const [method, p] of [['GET', '/admin/clients'], ['POST', '/admin/pair'], ['DELETE', '/admin/clients/' + 'a'.repeat(64)], ['GET', '/api/health']]) {
    assert.equal((await request(admin, method, p, { body: method === 'POST' ? {} : null })).status, 404, method + ' ' + p + ' on 8092')
  }

  const code = json(await request(port, 'GET', '/api/admin/code')).code
  assert.match(code, /^MPFY(-[0-9A-HJKMNP-TV-Z]{4}){8}$/)
  assert.equal(code, app.code)
  assert.deepEqual(json(await request(port, 'GET', '/api/admin/clients')), { clients: [] })
  let r = await request(port, 'DELETE', '/api/admin/clients/nope')
  assert.equal(r.status, 400)
  r = await request(port, 'DELETE', '/api/admin/clients/' + 'a'.repeat(64))
  assert.equal(r.status, 404)
  assert.equal(json(r).error, 'Dispositivo non trovato')
  r = await request(port, 'DELETE', '/api/admin/clients/self')
  assert.equal(r.status, 400, 'a local request is no device')
  // Rotation without P2P still changes the code on disk.
  const rotated = json(await request(port, 'POST', '/api/admin/code/rotate')).code
  assert.notEqual(rotated, code)
  assert.equal(json(await request(port, 'GET', '/api/admin/code')).code, rotated)
  assert.equal(app.code, rotated)
})
