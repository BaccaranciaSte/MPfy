// The id table and the likes table of a loaded person (server/idtable.mjs): every
// id found again at the index it was given, whatever the table grew to; ids that
// share their first bytes spread as well as random ones; the likes kept by slot in
// like order, with the versions that tell what was added since a version.

import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { IdTable, Likes } from '../server/idtable.mjs'

let seed = 7
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff
}
const hex = () => crypto.randomBytes(12).toString('hex')

test('id table: an id keeps its index while the table grows; find, intern and hex agree with a Map', () => {
  for (let round = 0; round < 10; round++) {
    const t = new IdTable(4)
    const ref = new Map()
    const ids = Array.from({ length: 3000 }, hex)
    for (let i = 0; i < 6000; i++) {
      const id = ids[Math.floor(rnd() * ids.length)]
      if (rnd() < 0.7) {
        const k = t.intern(id)
        if (ref.has(id)) assert.equal(k, ref.get(id), 'the same index again')
        else {
          assert.equal(k, ref.size, 'a new id takes the next index')
          ref.set(id, k)
        }
      } else assert.equal(t.find(id), ref.has(id) ? ref.get(id) : -1)
    }
    assert.equal(t.n, ref.size)
    for (const [id, k] of ref) {
      assert.equal(t.hex(k), id)
      assert.equal(t.find(id), k)
    }
    assert.ok(t.hash.length >= 2 * t.n, 'at most half full')
  }
})

test('id table: anything but 24 lowercase hex is refused, and two tables mix with seeds of their own', () => {
  const t = new IdTable()
  for (const bad of ['A'.repeat(24), 'ab', 'z'.repeat(24), 5, null, '0'.repeat(23) + 'g']) assert.throws(() => t.intern(bad), TypeError)
  assert.equal(t.n, 0)
  const seeds = new Set(Array.from({ length: 8 }, () => new IdTable().seed))
  assert.ok(seeds.size > 1, 'seeds drawn per table')
})

test('id table: 50,000 ids sharing their first 8 hex digits are interned in under 1 s', () => {
  const N = 50000
  for (const prefix of ['abcdef01', '00000000']) {
    const ids = Array.from({ length: N }, (_, i) => prefix + i.toString(16).padStart(16, '0'))
    const t = new IdTable(Math.ceil(N * 1.125))
    const start = performance.now()
    for (const id of ids) t.intern(id)
    for (const id of ids) assert.notEqual(t.find(id), -1)
    const ms = performance.now() - start
    assert.ok(ms < 1000, prefix + ': ' + Math.round(ms) + ' ms')
  }
  // The same ids differing only in their first or middle bytes.
  const tail = Array.from({ length: N }, (_, i) => i.toString(16).padStart(8, '0') + '0123456789abcdef')
  const t = new IdTable(Math.ceil(N * 1.125))
  const start = performance.now()
  for (const id of tail) t.intern(id)
  assert.ok(performance.now() - start < 1000)
})

test('likes: like, unlike and like again against a Map in like order; added since a version; repacks keep the order', () => {
  const pool = Array.from({ length: 3000 }, hex)
  let checks = 0
  for (let round = 0; round < 40; round++) {
    const t = new IdTable(4)
    const l = new Likes(t, 4)
    const ref = new Map() // id -> { at, v }, oldest first
    let v = 1000
    for (let i = 0; i < 2000; i++) {
      const id = pool[Math.floor(rnd() * pool.length)]
      v++
      if (rnd() < 0.6) {
        const did = l.add(t.intern(id), 1700000000000 + v, v)
        assert.equal(did, !ref.has(id))
        if (!ref.has(id)) ref.set(id, { at: 1700000000000 + v, v })
      } else {
        const did = l.remove(t.find(id))
        assert.equal(did, ref.has(id))
        ref.delete(id)
      }
      if (rnd() < 0.002) l.repack()
      if (i % 97 === 0) {
        checks++
        const got = []
        for (let s = l.n - 1; s >= 0; s--) if (!Number.isNaN(l.at[s])) got.push(t.hex(l.idx[s]) + ':' + l.at[s])
        assert.deepEqual(got, [...ref].reverse().map(([k, x]) => k + ':' + x.at), 'newest first')
        const u = v - Math.floor(rnd() * 300)
        const since = []
        for (let s = l.firstAfter(u); s < l.n; s++) if (!Number.isNaN(l.at[s])) since.push(t.hex(l.idx[s]))
        assert.deepEqual(since, [...ref].filter(([, x]) => x.v > u).map(([k]) => k), 'added since ' + u)
        for (let s = 1; s < l.n; s++) assert.ok(l.lv[s - 1] <= l.lv[s], 'versions never decrease along the slots')
        for (let k = 0; k < 50; k++) {
          const q = pool[Math.floor(rnd() * pool.length)]
          assert.equal(l.has(t.find(q)), ref.has(q))
          assert.equal(l.atOf(t.find(q)), ref.has(q) ? ref.get(q).at : null)
        }
        assert.equal(l.live, ref.size)
      }
    }
  }
  assert.ok(checks >= 800)
})

test('likes: no repack while a walk over the slots is under way; then the holes go', () => {
  const t = new IdTable()
  const l = new Likes(t)
  const ids = Array.from({ length: 20000 }, hex)
  ids.forEach((id, k) => l.add(t.intern(id), k, k))
  l.walkers++
  for (let k = 0; k < 15000; k++) l.remove(t.find(ids[k]))
  assert.equal(l.n, 20000, 'the slots stay while walked')
  l.walkers--
  l.remove(t.find(ids[15000]))
  assert.equal(l.n, l.live, 'repacked')
  assert.equal(l.live, 4999)
  assert.equal(t.hex(l.idx[0]), ids[15001])
  assert.equal(l.slotOf[t.find(ids[15001])], 1)
})
