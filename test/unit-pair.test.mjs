// Permanent pairing over a local HyperDHT testnet (a few DHT nodes in
// this process, UDP on 127.0.0.1 only, no Internet). The pairing listener's PUBLIC
// key is not a secret: the DHT nodes that store its announce record see it. These
// tests dial it with that key alone, as such a node could, and check that nobody
// gets in without the code, while every holder of the code pairs, as many times as
// needed, until the code is rotated.

import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import DHT from 'hyperdht'
import createTestnet from 'hyperdht/testnet.js'
import { MPfyTransportServer } from '../transport/server.js'
import { pair, generateKeyPair } from '../transport/client.js'
import { formatCode, pairSeedFromSecret, authKeyFromSecret, pairProof, encodeName, PAIR_PROOF_BYTES } from '../transport/code.js'
import { waitFor } from './helpers.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function setup (t, opts = {}) {
  const testnet = await createTestnet(3)
  const secret = crypto.randomBytes(20)
  const admitted = new Set()
  const paired = []
  const server = new MPfyTransportServer({
    seed: crypto.randomBytes(32),
    isAllowed: (key) => admitted.has(key),
    onPaired: (key, name) => {
      admitted.add(key)
      paired.push({ key, name })
    },
    pairingSecret: secret,
    sourceName: 'Mi A2',
    dht: testnet.createNode(),
    pairProofTimeout: 1500,
    ...opts
  })
  await server.listen()
  const nodes = []
  const node = () => {
    const n = testnet.createNode()
    nodes.push(n)
    return n
  }
  t.after(async () => {
    await server.close()
    await Promise.all(nodes.map((n) => n.destroy()))
    await testnet.destroy()
  })
  return { testnet, server, secret, code: formatCode(secret), admitted, paired, node }
}

const pairKeyOf = (secret) => DHT.keyPair(pairSeedFromSecret(secret)).publicKey

// Dial a key with a key pair (fresh by default); optionally write once open (a
// function gets the connection, to compute a proof from its handshake). Reports
// whether it opened and what came back.
function dial (node, publicKey, { keyPair = DHT.keyPair(), write = null, wait = 20000 } = {}) {
  return new Promise((resolve) => {
    const conn = node.connect(publicKey, { keyPair })
    let opened = false
    const got = []
    const timer = setTimeout(() => conn.destroy(), wait)
    conn.on('open', () => {
      opened = true
      const bytes = typeof write === 'function' ? write(conn) : write
      if (bytes) conn.write(bytes)
    })
    conn.on('data', (d) => got.push(d))
    conn.on('end', () => conn.end())
    conn.on('error', () => {})
    conn.on('close', () => {
      clearTimeout(timer)
      resolve({ opened, data: Buffer.concat(got) })
    })
  })
}

test('pairing: knowing the pairing key is not enough; every holder of the code pairs, with its name', { timeout: 90000 }, async (t) => {
  const { server, secret, code, paired, admitted, node } = await setup(t)
  const serverHex = Buffer.from(server.publicKey).toString('hex')
  assert.equal(server.pairingInfo().listening, true)
  assert.equal(server.pairingPublicKey, Buffer.from(pairKeyOf(secret)).toString('hex'))
  const stranger = node()

  // 1. Connects and sends a made-up proof (and a name).
  const forged = await dial(stranger, pairKeyOf(secret), { write: Buffer.concat([crypto.randomBytes(PAIR_PROOF_BYTES), encodeName('ladro')]) })
  assert.equal(forged.opened, true, 'the stranger reached the listener (there is no allow-list)')
  assert.equal(forged.data.length, 0, 'no answer for a wrong proof')
  assert.deepEqual(paired, [], 'nobody admitted on a wrong proof')
  assert.equal(server.stats.pairRefused, 1)

  // 2. A proof made with the right code but for ANOTHER handshake (a replay).
  const replayed = await dial(stranger, pairKeyOf(secret), {
    write: Buffer.concat([pairProof(authKeyFromSecret(secret), crypto.randomBytes(64)), encodeName('replay')])
  })
  assert.equal(replayed.data.length, 0)
  assert.deepEqual(paired, [])
  assert.equal(server.stats.pairRefused, 2)

  // 3. Connects and sends nothing: dropped after the proof timeout.
  const silent = await dial(stranger, pairKeyOf(secret))
  assert.equal(silent.opened, true)
  assert.equal(silent.data.length, 0)
  assert.equal(server.stats.pairRefused, 3)
  assert.deepEqual(paired, [], 'nobody admitted for just connecting')

  // 4. The holder of the code pairs: it learns the source key and name.
  const kp = generateKeyPair()
  const res = await pair(code.toLowerCase(), { keyPair: kp, name: 'REDMAGIC', dht: node(), timeout: 20000 })
  assert.deepEqual(res, { serverPublicKey: serverHex, name: 'Mi A2' })
  assert.deepEqual(paired, [{ key: kp.publicKey, name: 'REDMAGIC' }])

  // 5. The code is permanent: another device, later, with no name.
  const kp2 = generateKeyPair()
  const res2 = await pair(code, { keyPair: kp2, dht: node(), timeout: 20000 })
  assert.equal(res2.serverPublicKey, serverHex)
  assert.deepEqual(paired[1], { key: kp2.publicKey, name: 'Dispositivo' })
  assert.equal(server.pairingInfo().listening, true, 'still listening after two pairings')

  // 6. The paired key now gets through the main listener's firewall.
  const main = await dial(node(), server.publicKey, { keyPair: { publicKey: Buffer.from(kp.publicKey, 'hex'), secretKey: Buffer.from(kp.secretKey, 'hex') }, wait: 1500 })
  assert.equal(main.opened, true)
  assert.ok(admitted.has(kp2.publicKey))

  // A mistyped code names no listener at all.
  await assert.rejects(pair('MPFY-0000-0000-0000-0000-0000-0000-0000-000Z', { keyPair: generateKeyPair(), dht: node(), timeout: 3000 }),
    (err) => err.code === 'UNREACHABLE' && err.message === 'Fonte non raggiungibile')
  await assert.rejects(pair('MPFY-12', { keyPair: generateKeyPair(), dht: node() }), (err) => err.code === 'INVALID_CODE')
})

test('pairing: rate limits per remote key, in all, and on connections waiting for a proof', { timeout: 90000 }, async (t) => {
  const { server, secret, code, paired, node } = await setup(t, { pairLimits: { perKey: 2, total: 3, maxPending: 2 }, pairProofTimeout: 1000 })
  const n = node()
  const keyA = DHT.keyPair()
  const bad = () => Buffer.concat([crypto.randomBytes(PAIR_PROOF_BYTES), encodeName('x')])

  // Key A: two failed proofs, then it is not even let in.
  for (let i = 0; i < 2; i++) {
    const r = await dial(n, pairKeyOf(secret), { keyPair: keyA, write: bad() })
    assert.equal(r.opened, true, 'attempt ' + (i + 1) + ' reaches the listener')
  }
  assert.equal(server.stats.pairRefused, 2)
  const rejectedBefore = server.stats.pairRejected
  const third = await dial(n, pairKeyOf(secret), { keyPair: keyA, write: bad(), wait: 5000 })
  assert.equal(third.opened, false, 'a key over its limit is refused before any proof')
  assert.ok(server.stats.pairRejected > rejectedBefore)

  // Key B fails once: 3 failures in all, so now even the real code holder waits.
  const keyB = DHT.keyPair()
  assert.equal((await dial(n, pairKeyOf(secret), { keyPair: keyB, write: bad() })).opened, true)
  assert.equal(server.stats.pairRefused, 3)
  await assert.rejects(pair(code, { keyPair: generateKeyPair(), dht: node(), timeout: 3000 }), (err) => err.code === 'UNREACHABLE' || err.code === 'REFUSED')
  assert.deepEqual(paired, [], 'nobody admitted while the limit holds')
})

test('pairing: at most maxPending connections wait for their proof', { timeout: 60000 }, async (t) => {
  const { server, secret, node } = await setup(t, { pairLimits: { maxPending: 2 }, pairProofTimeout: 6000 })
  const n = node()
  // Two silent connections hold the two slots (they are dropped after 6 s).
  const waiting = [dial(n, pairKeyOf(secret), { wait: 10000 }), dial(n, pairKeyOf(secret), { wait: 10000 })]
  await sleep(1500)
  const third = await dial(n, pairKeyOf(secret), { wait: 3000 })
  assert.equal(third.opened, false, 'a third waiting connection is refused')
  const results = await Promise.all(waiting)
  assert.deepEqual(results.map((r) => r.opened), [true, true])
  assert.equal(server.stats.pairRefused, 2, 'both silent ones counted as failed proofs')
})

test('pairing: a connection that hangs up abruptly before its proof counts as a failed proof', { timeout: 60000 }, async (t) => {
  // The proof timeout is long: whatever is counted below was counted on the hang-up.
  const { server, secret, node } = await setup(t, { pairLimits: { perKey: 2, maxPending: 2 }, pairProofTimeout: 20000 })
  const n = node()
  const keyA = DHT.keyPair()
  // Open, send nothing, then destroy (no FIN): what a stranger holding a waiting
  // slot until just before the timeout does, or a link that dies.
  const dropAfterOpen = () => new Promise((resolve) => {
    const conn = n.connect(pairKeyOf(secret), { keyPair: keyA })
    let opened = false
    conn.on('open', () => {
      opened = true
      setTimeout(() => conn.destroy(), 200)
    })
    conn.on('error', () => {})
    conn.on('close', () => resolve(opened))
  })
  for (let i = 1; i <= 2; i++) {
    assert.equal(await dropAfterOpen(), true, 'attempt ' + i + ' reached the listener')
    await waitFor(() => server.stats.pairRefused === i, { timeout: 10000, what: 'hang-up ' + i + ' counted' })
  }
  assert.deepEqual(server.limiter.info(), { failures: 2, keys: 1 })
  // Counted, so the key is now over its limit: turned away before any proof.
  const third = await dial(n, pairKeyOf(secret), { keyPair: keyA, wait: 4000 })
  assert.equal(third.opened, false, 'a key that hung up twice is refused like one that failed twice')
  // And the waiting slots were given back: another key still gets in.
  const other = await dial(n, pairKeyOf(secret), { write: Buffer.concat([crypto.randomBytes(PAIR_PROOF_BYTES), encodeName('x')]) })
  assert.equal(other.opened, true)
})

test('pairing: a failed listen on the new code after a rotation is retried until it listens', async (t) => {
  // A DHT stand-in: no network; listen() can be made to fail.
  let failures = 0
  const servers = []
  const dht = {
    createServer (opts, onconnection) {
      const s = {
        keyPair: null,
        closed: false,
        async listen (keyPair) {
          if (failures > 0) {
            failures--
            throw new Error('bind failed')
          }
          s.keyPair = keyPair
        },
        async close () { s.closed = true }
      }
      servers.push(s)
      return s
    }
  }
  const secret1 = crypto.randomBytes(20)
  const server = new MPfyTransportServer({
    seed: crypto.randomBytes(32), isAllowed: () => false, onPaired: () => {}, pairingSecret: secret1, dht, pairingRetryMs: 50
  })
  t.after(() => server.close())
  const events = []
  server.on('pairing-error', (e) => events.push('error: ' + e.error))
  server.on('pairing-listening', () => events.push('listening'))
  await server.listen()
  assert.equal(server.pairingInfo().listening, true)
  const listeningOn = () => servers.filter((s) => s.keyPair !== null && !s.closed).map((s) => Buffer.from(s.keyPair.publicKey).toString('hex'))
  const hex = (secret) => Buffer.from(pairKeyOf(secret)).toString('hex')

  // The rotation's own listen fails, and so does the first retry.
  failures = 2
  const secret2 = crypto.randomBytes(20)
  await assert.rejects(server.setPairingSecret(secret2), /bind failed/)
  assert.equal(server.pairingInfo().listening, false, 'the old listener is gone at once')
  await waitFor(() => server.pairingInfo().listening, { timeout: 5000, what: 'the pairing listener back' })
  assert.deepEqual(events, ['error: bind failed', 'listening'])
  assert.deepEqual(listeningOn(), [server.publicKey.toString('hex'), hex(secret2)], 'the main key and the NEW pairing key')

  // A newer rotation while a retry is pending wins; the stale retry does nothing.
  failures = 1
  await assert.rejects(server.setPairingSecret(crypto.randomBytes(20)))
  const secret4 = crypto.randomBytes(20)
  await server.setPairingSecret(secret4)
  const created = servers.length
  await sleep(200)
  assert.equal(servers.length, created, 'no listener made by the stale retry')
  assert.deepEqual(listeningOn(), [server.publicKey.toString('hex'), hex(secret4)])

  // close() stops a pending retry.
  failures = 1
  await assert.rejects(server.setPairingSecret(crypto.randomBytes(20)))
  await server.close()
  const afterClose = servers.length
  await sleep(200)
  assert.equal(servers.length, afterClose, 'no listen after close()')
})

test('pairing: rotation stops the old code at once (even mid-connection); the new code pairs', { timeout: 90000 }, async (t) => {
  const { server, secret, code, paired, node } = await setup(t, { pairProofTimeout: 8000 })
  const kpA = generateKeyPair()
  await pair(code, { keyPair: kpA, name: 'A', dht: node(), timeout: 20000 })
  assert.equal(paired.length, 1)

  // A connection to the old listener opens BEFORE the rotation and sends a good
  // proof AFTER it: nothing is admitted.
  const oldAuth = authKeyFromSecret(secret)
  const kpLate = DHT.keyPair()
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const late = new Promise((resolve) => {
    const conn = node().connect(pairKeyOf(secret), { keyPair: kpLate })
    const got = []
    conn.on('open', async () => {
      await gate
      conn.write(Buffer.concat([pairProof(oldAuth, conn.handshakeHash), encodeName('tardi')]))
    })
    conn.on('data', (d) => got.push(d))
    conn.on('end', () => conn.end())
    conn.on('error', () => {})
    conn.on('close', () => resolve(Buffer.concat(got)))
    setTimeout(() => conn.destroy(), 15000)
  })
  await sleep(1500) // the late connection is open by now

  const secret2 = crypto.randomBytes(20)
  await server.setPairingSecret(secret2)
  release()
  assert.equal((await late).length, 0, 'no answer on the old code after the rotation')
  assert.equal(paired.length, 1, 'nobody admitted on the old code')

  await assert.rejects(pair(code, { keyPair: generateKeyPair(), dht: node(), timeout: 4000 }), (err) => err.code === 'UNREACHABLE' || err.code === 'REFUSED')
  const kpB = generateKeyPair()
  const res = await pair(formatCode(secret2), { keyPair: kpB, name: 'B', dht: node(), timeout: 20000 })
  assert.equal(res.name, 'Mi A2')
  assert.deepEqual(paired.map((p) => p.name), ['A', 'B'])
  assert.equal(server.pairingInfo().publicKey, Buffer.from(pairKeyOf(secret2)).toString('hex'))
})
