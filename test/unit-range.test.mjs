import test from 'node:test'
import assert from 'node:assert/strict'
import { parseRange, UNSATISFIABLE } from '../server/range.mjs'

test('range: no header or other units means the whole file', () => {
  assert.equal(parseRange(undefined, 1000), null)
  assert.equal(parseRange('', 1000), null)
  assert.equal(parseRange('items=0-1', 1000), null)
})

test('range: closed, open-ended and suffix ranges', () => {
  assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 })
  assert.deepEqual(parseRange('bytes=100-', 1000), { start: 100, end: 999 })
  assert.deepEqual(parseRange('bytes=-200', 1000), { start: 800, end: 999 })
  assert.deepEqual(parseRange('bytes=0-0', 1000), { start: 0, end: 0 })
  assert.deepEqual(parseRange(' Bytes = 5 - 9 ', 1000), { start: 5, end: 9 })
})

test('range: end past the size is clamped, suffix longer than the file is the whole file', () => {
  assert.deepEqual(parseRange('bytes=900-5000', 1000), { start: 900, end: 999 })
  assert.deepEqual(parseRange('bytes=-5000', 1000), { start: 0, end: 999 })
  assert.deepEqual(parseRange('bytes=0-99999999999999999999', 1000), { start: 0, end: 999 })
})

test('range: unsatisfiable', () => {
  assert.equal(parseRange('bytes=1000-', 1000), UNSATISFIABLE)
  assert.equal(parseRange('bytes=1000-2000', 1000), UNSATISFIABLE)
  assert.equal(parseRange('bytes=-0', 1000), UNSATISFIABLE)
  assert.equal(parseRange('bytes=0-', 0), UNSATISFIABLE)
})

test('range: malformed or multiple ranges are ignored', () => {
  assert.equal(parseRange('bytes=abc', 1000), null)
  assert.equal(parseRange('bytes=-', 1000), null)
  assert.equal(parseRange('bytes=10-5', 1000), null)
  assert.equal(parseRange('bytes=0-1,5-6', 1000), null)
  assert.equal(parseRange('bytes=1.5-2', 1000), null)
  assert.equal(parseRange('bytes=' + '1'.repeat(300) + '-', 1000), null)
})
