// The permanent pairing code: format, parsing, derivations, the proof,
// the names on the wire, the rate limiter. No network.

import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import sodium from 'sodium-native'
import {
  formatCode, parseCode, normalizeCode, generateSecret, pairSeedFromSecret, authKeyFromSecret,
  pairProof, checkPairProof, encodeName, decodeName, PAIR_PROOF_BYTES, MAX_NAME_BYTES
} from '../transport/code.js'
import { PairLimiter, PAIR_LIMITS } from '../transport/server.js'

const CODE_RE = /^MPFY(-[0-9A-HJKMNP-TV-Z]{4}){8}$/

// BLAKE2b-256 straight from libsodium, to check the derivations independently.
function blake2b256 (...parts) {
  const out = Buffer.alloc(32)
  sodium.crypto_generichash(out, Buffer.concat(parts))
  return out
}

test('code: MPFY- plus 32 Crockford characters in 8 groups of 4; round trip', () => {
  for (let i = 0; i < 200; i++) {
    const secret = generateSecret()
    assert.equal(secret.byteLength, 20)
    const code = formatCode(secret)
    assert.match(code, CODE_RE)
    assert.ok(Buffer.from(parseCode(code)).equals(Buffer.from(secret)), code)
  }
  assert.equal(formatCode(Buffer.alloc(20)), 'MPFY-0000-0000-0000-0000-0000-0000-0000-0000')
  assert.equal(formatCode(Buffer.alloc(20, 0xff)), 'MPFY-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ')
  // Bit order: the first 5 bits of the first byte make the first character.
  const one = Buffer.alloc(20)
  one[0] = 0x08 // 00001 000
  assert.equal(formatCode(one).slice(5, 9), '1000')
  assert.throws(() => formatCode(Buffer.alloc(19)))
})

test('code: parsing ignores case, spaces and dashes, maps I and L to 1 and O to 0, prefix optional', () => {
  const secret = crypto.randomBytes(20)
  const code = formatCode(secret)
  const bare = code.slice(5).replace(/-/g, '')
  const same = (input) => assert.ok(Buffer.from(parseCode(input)).equals(secret), JSON.stringify(input))
  same(code)
  same(code.toLowerCase())
  same(bare)
  same(bare.toLowerCase())
  same('  ' + code.replace(/-/g, ' ') + '\n')
  same('mpfy ' + bare.match(/.{1,4}/g).join(' - '))
  same(code.replace(/-/g, '\u2013')) // a phone keyboard's typographic dash
  same(code.replace(/-/g, ''))

  // I and L read as 1, O as 0 (never part of the alphabet).
  const ones = formatCode(Buffer.alloc(20)).replace(/0/g, 'O')
  assert.ok(Buffer.from(parseCode(ones)).equals(Buffer.alloc(20)), 'O is 0')
  const withOne = Buffer.alloc(20)
  withOne[0] = 0x08 // first character "1"
  const typed = 'MPFY-' + 'I' + formatCode(withOne).slice(6)
  assert.ok(Buffer.from(parseCode(typed)).equals(withOne), 'I is 1')
  assert.ok(Buffer.from(parseCode(typed.replace('I', 'l'))).equals(withOne), 'l is 1')

  assert.equal(normalizeCode(bare.toLowerCase()), code)
  assert.equal(normalizeCode('nope'), null)
})

test('code: wrong length, U, other characters, other types are "Codice non valido"', () => {
  const code = formatCode(crypto.randomBytes(20))
  const bad = [
    '', 'MPFY', code.slice(0, -1), code + 'A', code.slice(0, -1) + 'U', code.slice(0, -1) + '*',
    'XPFY' + code.slice(4), 'old1:' + 'a'.repeat(64) + ':' + 'b'.repeat(64)
  ]
  for (const input of bad) {
    assert.throws(() => parseCode(input), (err) => err.code === 'INVALID_CODE' && err.message === 'Codice non valido', JSON.stringify(input))
  }
  for (const input of [null, undefined, 42, {}]) assert.throws(() => parseCode(input), (err) => err.code === 'INVALID_CODE')
})

test('derivations: BLAKE2b-256 with the fixed tags; seed, auth key and proof all differ', () => {
  const secret = crypto.randomBytes(20)
  const seed = pairSeedFromSecret(secret)
  const auth = authKeyFromSecret(secret)
  assert.ok(Buffer.from(seed).equals(blake2b256(Buffer.from('mpfy/pair-seed/1'), secret)))
  assert.ok(Buffer.from(auth).equals(blake2b256(Buffer.from('mpfy/pair-auth/1'), secret)))
  assert.ok(!Buffer.from(seed).equals(Buffer.from(auth)))
  const hh = crypto.randomBytes(64)
  const proof = pairProof(auth, hh)
  assert.ok(Buffer.from(proof).equals(blake2b256(Buffer.from('mpfy/pair-proof/1'), auth, hh)))
  assert.equal(proof.byteLength, PAIR_PROOF_BYTES)
})

test('proof: bound to the secret and to the handshake, checked exactly', () => {
  const auth = authKeyFromSecret(crypto.randomBytes(20))
  const hash = crypto.randomBytes(64)
  const proof = pairProof(auth, hash)
  assert.equal(checkPairProof(auth, hash, proof), true)
  assert.equal(checkPairProof(authKeyFromSecret(crypto.randomBytes(20)), hash, proof), false, 'another code')
  assert.equal(checkPairProof(auth, crypto.randomBytes(64), proof), false, 'another connection')
  assert.equal(checkPairProof(auth, hash, proof.subarray(0, 31)), false, 'short')
  assert.equal(checkPairProof(auth, hash, Buffer.concat([proof, Buffer.from([0])])), false, 'long')
  assert.equal(checkPairProof(auth, null, proof), false, 'no handshake')
  const flipped = Buffer.from(proof)
  flipped[31] ^= 1
  assert.equal(checkPairProof(auth, hash, flipped), false, 'one bit')
})

test('names: u8 length plus UTF-8, at most 60 bytes, never a broken character', () => {
  assert.deepEqual([...encodeName('Pixel')], [5, ...Buffer.from('Pixel')])
  assert.deepEqual([...encodeName('')], [0])
  assert.equal(decodeName(Buffer.alloc(0), 'Dispositivo'), 'Dispositivo')
  const long = '\u00e8'.repeat(40) // 80 bytes
  const enc = encodeName(long)
  assert.equal(enc[0], MAX_NAME_BYTES)
  assert.equal(decodeName(enc.subarray(1)), '\u00e8'.repeat(30))
  const odd = 'a' + '\u00e8'.repeat(40) // a 2-byte character would straddle byte 60
  const enc2 = encodeName(odd)
  assert.equal(enc2[0], 59)
  assert.equal(decodeName(enc2.subarray(1)), 'a' + '\u00e8'.repeat(29))
  assert.equal(decodeName(Buffer.from('  REDMAGIC\u0007 ')), 'REDMAGIC')
})

test('limiter: 5 failures per key and 30 in all per 10 minutes, sliding', () => {
  let now = 1_000_000
  const lim = new PairLimiter({ now: () => now })
  assert.deepEqual([PAIR_LIMITS.perKey, PAIR_LIMITS.total, PAIR_LIMITS.windowMs, PAIR_LIMITS.maxPending], [5, 30, 600000, 8])
  for (let i = 0; i < 5; i++) {
    assert.equal(lim.allowed('a'), true, 'attempt ' + (i + 1))
    lim.fail('a')
    now += 1000
  }
  assert.equal(lim.allowed('a'), false, 'a sixth failure of the same key is not even tried')
  assert.equal(lim.allowed('b'), true, 'other keys are not affected')
  // 25 more failures from 25 keys reach the total of 30.
  for (let i = 0; i < 25; i++) lim.fail('k' + i)
  assert.equal(lim.allowed('fresh'), false, '30 in all: everyone waits')
  // The window slides: 10 minutes after the first failure of "a" it frees one slot.
  now = 1_000_000 + 600000 + 1
  assert.equal(lim.allowed('fresh'), true)
  assert.equal(lim.allowed('a'), true, 'a got one attempt back')
  now += 600000
  assert.deepEqual(lim.info(), { failures: 0, keys: 0 }, 'old entries are forgotten')
})
