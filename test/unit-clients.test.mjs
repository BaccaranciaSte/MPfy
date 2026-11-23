// clients.json, the list the HyperDHT firewall admits, and keys.json.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ClientsStore } from '../server/clients.mjs'
import { loadOrCreateSeed } from '../server/keys.mjs'
import { tmpDir, rmDir } from './helpers.mjs'

const K1 = '1'.repeat(64)
const K2 = '2'.repeat(64)
const K3 = '3'.repeat(64)

test('clients: add, has, remove, persisted', (t) => {
  const dir = tmpDir()
  t.after(() => rmDir(dir))
  const store = new ClientsStore(dir)
  assert.equal(store.has(K1), false)
  store.add(K1, 'redmagic')
  store.add(K1.toUpperCase(), 'rinominato') // same key, any case: one entry
  assert.equal(store.has(K1), true)
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'clients.json'), 'utf8'))
  assert.equal(onDisk.length, 1)
  assert.equal(onDisk[0].publicKey, K1)
  assert.equal(onDisk[0].name, 'rinominato')
  assert.ok(onDisk[0].addedAt > 0)
  assert.equal(store.remove(K1), true)
  assert.equal(store.remove(K1), false)
  assert.equal(store.has(K1), false)
  assert.throws(() => store.add('nope', 'x'))
})

test('clients: an edit of clients.json is picked up without a restart; a broken edit keeps the last good list', (t) => {
  const dir = tmpDir()
  t.after(() => rmDir(dir))
  const store = new ClientsStore(dir)
  store.add(K1, 'a')
  const file = path.join(dir, 'clients.json')
  fs.writeFileSync(file, JSON.stringify([{ publicKey: K2, name: 'b', addedAt: 1 }, { publicKey: K3, name: 'c', addedAt: 2 }]))
  assert.equal(store.has(K1), false)
  assert.equal(store.has(K2), true)
  assert.equal(store.has(K3), true)
  fs.writeFileSync(file, '[{"publicKey": "' + K1) // half-written by hand
  assert.equal(store.has(K2), true, 'last good list kept')
  assert.equal(store.has(K1), false)
  fs.unlinkSync(file)
  assert.equal(store.has(K2), false, 'no file, nobody admitted')
})

const corruptCopies = (dir) => fs.readdirSync(dir).filter((n) => /^clients\.json\.corrupt-\d+$/.test(n))

test('clients: a clients.json broken at startup is set aside, not written over, on the next pairing', (t) => {
  const dir = tmpDir()
  t.after(() => rmDir(dir))
  const file = path.join(dir, 'clients.json')
  // A hand edit with a trailing comma: the REDMAGIC's key is in there.
  const broken = '[{"publicKey": "' + K1 + '", "name": "redmagic", "addedAt": 1},]\n'
  fs.writeFileSync(file, broken)
  const store = new ClientsStore(dir)
  assert.equal(store.has(K1), false, 'an unreadable file admits nobody')
  store.add(K2, 'pc')
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(onDisk.map((c) => c.publicKey), [K2])
  const copies = corruptCopies(dir)
  assert.equal(copies.length, 1, 'the broken file was kept aside')
  assert.equal(fs.readFileSync(path.join(dir, copies[0]), 'utf8'), broken, 'byte for byte')
  // Once set aside, later writes are ordinary ones.
  store.add(K3, 'altro')
  assert.equal(corruptCopies(dir).length, 1)
})

test('clients: a clients.json broken while running is set aside before remove() writes the last good list', (t) => {
  const dir = tmpDir()
  t.after(() => rmDir(dir))
  const file = path.join(dir, 'clients.json')
  const store = new ClientsStore(dir)
  store.add(K1, 'a')
  store.add(K2, 'b')
  const broken = '[{"publicKey": "' + K3 + '"'
  fs.writeFileSync(file, broken)
  assert.equal(store.has(K1), true, 'last good list kept')
  assert.equal(store.remove(K2), true)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).map((c) => c.publicKey), [K1])
  const copies = corruptCopies(dir)
  assert.equal(copies.length, 1)
  assert.equal(fs.readFileSync(path.join(dir, copies[0]), 'utf8'), broken)
})

test('keys: the seed is created once and then kept; a damaged keys.json stops the server', (t) => {
  const dir = tmpDir()
  t.after(() => rmDir(dir))
  const a = loadOrCreateSeed(dir)
  const b = loadOrCreateSeed(dir)
  assert.equal(a.length, 32)
  assert.ok(a.equals(b))
  fs.writeFileSync(path.join(dir, 'keys.json'), '{"seed": "zz"}')
  assert.throws(() => loadOrCreateSeed(dir), /seed/)
  fs.writeFileSync(path.join(dir, 'keys.json'), 'not json')
  assert.throws(() => loadOrCreateSeed(dir), /keys\.json/)
})
