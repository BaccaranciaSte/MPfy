// The client API under /api/admin through real P2P links on a local HyperDHT
// testnet: "you" in the client list (the HTTP server maps the socket's remote
// port to the transport channel), the owner and a member (the member sees only
// its own devices and cannot rotate), rotation through the API (old code
// refused, paired devices kept), revoking another device and oneself ("self"),
// both closing the connections, even when the device hangs up before its answer;
// and the CLI (code, rotate-code, clients, revoke) with the server running and stopped.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import createTestnet from 'hyperdht/testnet.js'
import { createMPfy } from '../server/app.mjs'
import { createApiHandler } from '../server/http.mjs'
import { People } from '../server/people.mjs'
import { runCommand } from '../server/index.mjs'
import { MPfyLink, pair, generateKeyPair } from '../transport/client.js'
import { tmpDir, rmDir, request, json, waitFor, listenServer, closeServer, makeProfile, proofHeaders } from './helpers.mjs'

const body = (res) => JSON.parse(Buffer.from(res.body).toString('utf8'))

async function setup (t) {
  const testnet = await createTestnet(3)
  const dir = tmpDir()
  const nodes = []
  const links = []
  const node = () => {
    const n = testnet.createNode()
    nodes.push(n)
    return n
  }
  const app = await createMPfy({ dataDir: dir, port: 0, adminPort: 0, p2p: true, waitForDht: true, dht: node(), ffmpeg: null, debounceMs: 20, name: 'Fonte di prova' })
  t.after(async () => {
    for (const l of links) await l.close()
    await app.close()
    await Promise.all(nodes.map((n) => n.destroy()))
    await testnet.destroy()
    rmDir(dir)
  })
  // Pair a device and start its link; with a profile its requests carry the
  // profile headers, as the client core sends them.
  const device = async (name, code = app.code, profile = null) => {
    const keyPair = generateKeyPair()
    const res = await pair(code, { keyPair, name, dht: node(), timeout: 20000 })
    const link = new MPfyLink({ serverPublicKey: res.serverPublicKey, keyPair, dht: node() })
    links.push(link)
    link.start()
    assert.equal(await link.waitConnected(15000), true, name + ' connects')
    const headers = profile ? proofHeaders(profile, keyPair.publicKey, app.serverPublicKey) : {}
    const call = (method, urlPath, opts = {}) => link.request(method, urlPath, { ...opts, headers: { ...headers, ...(opts.headers || {}) } })
    return { keyPair, link, res, call }
  }
  return { app, dir, node, device, port: app.ports.http }
}

test('admin API over P2P: you, the code, rotation keeping paired devices, revoke another and self', { timeout: 120000 }, async (t) => {
  const { app, dir, device, node, port } = await setup(t)
  const code = json(await request(port, 'GET', '/api/admin/code')).code
  assert.equal(code, app.code)

  // The owner window opened on the source: A's profile claims at its first request.
  app.people.openClaim(30)
  const owner = makeProfile()
  const member = makeProfile()
  const a = await device('Telefono A', code, owner)
  assert.deepEqual(a.res, { serverPublicKey: app.serverPublicKey, name: 'Fonte di prova' })
  const b = await device('PC B', code, member)

  // "you" is the device the request comes through; a local request is nobody.
  const listA = body(await a.call('GET', '/api/admin/clients'))
  assert.equal(app.source.ownerProfileId, owner.id, 'the first binding in the window claimed')
  assert.deepEqual(listA.clients.map((c) => [c.name, c.connected, c.you, c.profileId]), [['Telefono A', true, true, owner.id], ['PC B', true, false, null]])
  assert.equal(listA.clients[0].publicKey, a.keyPair.publicKey)
  assert.ok(listA.clients[0].addedAt > 0)
  const listB = body(await b.call('GET', '/api/admin/clients'))
  assert.deepEqual(listB.clients.map((c) => [c.name, c.you, c.profileId]), [['PC B', true, member.id]], 'a member sees its own devices only')
  const local = json(await request(port, 'GET', '/api/admin/clients'))
  assert.deepEqual(local.clients.map((c) => c.you), [false, false])
  assert.equal(body(await a.call('GET', '/api/admin/code')).code, code, 'a paired device can show the code')
  assert.equal(body(await b.call('GET', '/api/admin/code')).code, code, 'a member too')
  const refused = await b.call('POST', '/api/admin/code/rotate')
  assert.equal(refused.status, 403)
  assert.equal(body(refused).code, 'forbidden', 'only the owner changes the code')

  // Rotation through the owner's device: the old code admits nobody, the paired stay.
  const rotated = await a.call('POST', '/api/admin/code/rotate', { timeout: 30000 })
  assert.equal(rotated.status, 200)
  const code2 = body(rotated).code
  assert.notEqual(code2, code)
  assert.equal(app.code, code2)
  assert.match(fs.readFileSync(path.join(dir, 'pairing.json'), 'utf8'), /"secret": "[0-9a-f]{40}"/)
  await assert.rejects(pair(code, { keyPair: generateKeyPair(), dht: node(), timeout: 4000 }), (err) => err.code === 'UNREACHABLE' || err.code === 'REFUSED')
  const c = await device('Tablet C', code2)
  assert.equal((await a.call('GET', '/api/health')).status, 200, 'A still works after the rotation')
  assert.equal((await b.call('GET', '/api/health')).status, 200, 'B still works after the rotation')
  assert.equal(app.clients.list().length, 3)
  assert.equal((await b.call('DELETE', '/api/admin/clients/' + c.keyPair.publicKey)).status, 403, 'a member removes only its own devices')

  // A revokes C: C's connection is closed and C cannot come back.
  const r1 = await a.call('DELETE', '/api/admin/clients/' + c.keyPair.publicKey.toUpperCase())
  assert.equal(r1.status, 200)
  assert.deepEqual(body(r1), { ok: true })
  await waitFor(() => !c.link.status.connected, { timeout: 10000, what: 'C disconnected' })
  assert.equal(app.clients.has(c.keyPair.publicKey), false)
  const rejected = app.transport.stats.rejected
  assert.equal(await c.link.waitConnected(4000), false, 'C is refused by the firewall now')
  assert.ok(app.transport.stats.rejected > rejected)

  // B removes itself: it gets its answer, then its connection is closed.
  const r2 = await b.call('DELETE', '/api/admin/clients/self', { timeout: 5000 })
  assert.equal(r2.status, 200)
  assert.deepEqual(body(r2), { ok: true })
  await waitFor(() => !b.link.status.connected, { timeout: 10000, what: 'B disconnected' })
  assert.equal(app.clients.has(b.keyPair.publicKey), false)
  assert.equal(await b.link.waitConnected(4000), false)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'clients.json'), 'utf8')).map((x) => x.name), ['Telefono A'])

  // A is untouched.
  const left = body(await a.call('GET', '/api/admin/clients'))
  assert.deepEqual(left.clients.map((x) => [x.name, x.you]), [['Telefono A', true]])
  assert.equal(a.link.status.connected, true)
})

test('CLI: code, clients, rotate-code and revoke, with the server running and stopped', { timeout: 120000 }, async (t) => {
  const { app, dir, device, port } = await setup(t)
  const opts = { dataDir: dir, port }
  const codeLines = await runCommand(['code'], opts)
  assert.equal(codeLines[0], app.code)
  assert.equal(codeLines[1], 'Nessun proprietario: chi aggiunge la fonte nei prossimi 30 minuti lo diventa.', 'with no owner, code opens the window, in minutes from now')
  assert.ok(app.source.claimOpen())

  const a = await device('Telefono A')
  const lines = await runCommand(['clients'], opts)
  assert.equal(lines.length, 1)
  assert.match(lines[0], new RegExp('^' + a.keyPair.publicKey + '  Telefono A  dal \\d{4}-\\d{2}-\\d{2}  connesso$'))

  const before = app.code
  const rotated = await runCommand(['rotate-code'], opts)
  assert.match(rotated[0], /^MPFY(-[0-9A-HJKMNP-TV-Z]{4}){8}$/)
  assert.notEqual(rotated[0], before)
  assert.equal(app.code, rotated[0], 'the running server switched at once')
  assert.match(rotated[1], /precedente non funziona/)

  await assert.rejects(runCommand(['revoke', 'abc'], opts), /uso:/)
  await assert.rejects(runCommand(['revoke', 'f'.repeat(64)], opts), /Dispositivo non trovato/)
  assert.deepEqual(await runCommand(['revoke', a.keyPair.publicKey], opts), ['Dispositivo rimosso: le sue connessioni sono state chiuse.'])
  await waitFor(() => !a.link.status.connected, { timeout: 10000, what: 'A disconnected' })

  // Server stopped: the commands edit the files.
  const b = await device('PC B')
  await b.link.close()
  await app.close()
  const down = { dataDir: dir, port } // nothing listens there now
  const offline = await runCommand(['clients'], down)
  assert.match(offline[0], /PC B .* server spento$/)
  const codeBefore = (await runCommand(['code'], down))[0]
  const r = await runCommand(['rotate-code'], down)
  assert.notEqual(r[0], codeBefore)
  assert.match(r[1], /server spento/)
  assert.equal((await runCommand(['code'], down))[0], r[0], 'pairing.json holds the new code')
  assert.deepEqual(await runCommand(['revoke', b.keyPair.publicKey], down), ['Dispositivo rimosso (server spento).'])
  assert.deepEqual(await runCommand(['clients'], down), ['Nessun dispositivo collegato.'])
  await assert.rejects(runCommand(['boh'], down), /comando sconosciuto/)
})

test('CLI: code on a fresh data dir creates pairing.json (0600 where the OS has modes)', async (t) => {
  const dir = tmpDir()
  t.after(() => rmDir(dir))
  const [code, line] = await runCommand(['code'], { dataDir: path.join(dir, 'nuova'), port: 1 })
  assert.match(code, /^MPFY(-[0-9A-HJKMNP-TV-Z]{4}){8}$/)
  assert.match(line, /^Nessun proprietario/)
  const source = JSON.parse(fs.readFileSync(path.join(dir, 'nuova', 'source.json'), 'utf8'))
  assert.ok(source.claimUntil > Date.now() + 29 * 60000, 'the window opened in source.json, server stopped')
  assert.equal(source.migratedAt, null, 'a fresh data dir is not an older one')
  const file = path.join(dir, 'nuova', 'pairing.json')
  assert.ok(fs.existsSync(file))
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.equal((await runCommand(['code'], { dataDir: path.join(dir, 'nuova'), port: 1 }))[0], code, 'the same code every time')
  // A damaged pairing.json is set aside and a new code made.
  fs.writeFileSync(file, '{"secret": "zz"}')
  const [code2] = await runCommand(['code'], { dataDir: path.join(dir, 'nuova'), port: 1 })
  assert.notEqual(code2, code)
  assert.equal(fs.readdirSync(path.join(dir, 'nuova')).filter((n) => /^pairing\.json\.corrupt-\d+$/.test(n)).length, 1)
})

test('self-revoke: the connection is revoked even when the device hangs up before the answer is out', async (t) => {
  // The API handler alone, with stand-ins: the device's request arrives (from
  // 127.0.0.2, as the transport opens it), and its connection goes away while the
  // server handles it (client-core gives this call 2 s; a link can drop in the
  // car). The answer then never finishes.
  const KEY = 'ab'.repeat(32)
  const drops = []
  let current = null
  const removed = []
  const entry = { publicKey: KEY, name: 'Telefono', addedAt: 1 }
  const clients = {
    get: (key) => (key === KEY && removed.length === 0 ? { ...entry } : null),
    remove (key) {
      removed.push(key)
      current.req.socket.destroy() // the device hangs up right now
      return key === KEY
    }
  }
  const transport = { dropClient: (key, opts) => { drops.push({ key, opts }); return 1 } }
  const people = new People({
    source: { ownerProfileId: null },
    profiles: {},
    clients,
    recovery: { deleteDevice () {} },
    transport: () => transport,
    serverPublicKey: 'cd'.repeat(32)
  })
  const handler = createApiHandler({
    library: {},
    people,
    clients,
    transport: () => transport,
    whoIs: () => KEY,
    staticFiles: null,
    extraHosts: new Set()
  })
  const server = http.createServer((req, res) => {
    current = { req, closed: new Promise((resolve) => res.once('close', resolve)) }
    handler(req, res)
  })
  const port = await listenServer(server)
  t.after(() => {
    server.closeAllConnections()
    return closeServer(server)
  })
  const sock = net.createConnection({ port, host: '127.0.0.1', localAddress: '127.0.0.2' })
  sock.on('error', () => {})
  sock.write('DELETE /api/admin/clients/self HTTP/1.1\r\nHost: 127.0.0.1:8091\r\nConnection: close\r\n\r\n')
  await waitFor(() => current !== null, { what: 'the request' })
  await current.closed
  await new Promise((resolve) => setTimeout(resolve, 50))
  sock.destroy()
  assert.deepEqual(removed, [KEY])
  assert.deepEqual(drops, [{ key: KEY, opts: { graceMs: 3000 } }], 'its live connection is revoked too, answer or not')
})
