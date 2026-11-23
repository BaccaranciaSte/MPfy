// Permanent pairing codes and the key helpers shared by both sides.
//
// A source holds a 20-byte random secret (pairing.json). Bacca sees it as
//   MPFY-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX
// (32 Crockford base32 characters, 160 bits, in 8 groups of 4). From the secret:
//   pairSeed = BLAKE2b-256("mpfy/pair-seed/1" || secret)  -> HyperDHT key pair the
//              source listens on, all the time, for pairing connections
//   authKey  = BLAKE2b-256("mpfy/pair-auth/1" || secret)
//   proof    = BLAKE2b-256("mpfy/pair-proof/1" || authKey || handshakeHash)
// The pairing PUBLIC key is not a secret (the DHT nodes storing the announce see
// it), so a connection is admitted only after it sends a proof bound to its own
// Noise handshake: it cannot be replayed on another connection or for another key.
//
// Portable: b4a and hypercore-crypto only (Node and Bare).

import b4a from 'b4a'
import hcrypto from 'hypercore-crypto'

// Name of the pairing exchange. It runs as raw bytes on its own short connection to
// the pairing key (no protomux there): proof (32) + name (u8 + UTF-8) from the
// client; 0x01 + main public key (32) + name (u8 + UTF-8) from the source. The
// TCP channels of a main connection use pipe.js PROTOCOL, "mpfy/tcp/1".
export const PAIR_PROTOCOL = 'mpfy/pair/1'

export const SECRET_BYTES = 20
export const CODE_PREFIX = 'MPFY'
export const PAIR_PROOF_BYTES = 32
// Device and source names travel as a u8 length plus UTF-8, at most this many bytes.
export const MAX_NAME_BYTES = 60

// Crockford base32: no I, L, O, U.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CODE_CHARS = 32 // 20 bytes * 8 bits / 5 bits per character

const TAG_PAIR_SEED = b4a.from('mpfy/pair-seed/1')
const TAG_PAIR_AUTH = b4a.from('mpfy/pair-auth/1')
const TAG_PAIR_PROOF = b4a.from('mpfy/pair-proof/1')

function codeError (message = 'Codice non valido') {
  const err = new Error(message)
  err.code = 'INVALID_CODE'
  return err
}

function checkSecret (secret) {
  if (!secret || secret.byteLength !== SECRET_BYTES) throw new Error('segreto di abbinamento non valido')
  return secret
}

/** A fresh random pairing secret (20 bytes). */
export function generateSecret () {
  return hcrypto.randomBytes(SECRET_BYTES)
}

/** secret (20 bytes) -> "MPFY-7K3Q-9XWD-...". */
export function formatCode (secret) {
  checkSecret(secret)
  let bits = 0
  let value = 0
  let out = ''
  for (let i = 0; i < secret.byteLength; i++) {
    value = (value << 8) | secret[i]
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
    value &= 0xff // keep only what has not been emitted yet (bits < 8 after the loop)
  }
  const groups = []
  for (let i = 0; i < out.length; i += 4) groups.push(out.slice(i, i + 4))
  return CODE_PREFIX + '-' + groups.join('-')
}

/**
 * Code as typed or pasted -> secret (20 bytes). Ignores case, spaces and dashes
 * (also the typographic dashes a phone keyboard may substitute); maps I and L to 1
 * and O to 0; the "MPFY" prefix is optional.
 * Throws an Error with code 'INVALID_CODE' (message "Codice non valido").
 */
export function parseCode (code) {
  if (typeof code !== 'string') throw codeError()
  let s = code.toUpperCase().replace(/[\s\-_\u2010-\u2015\u2212]/g, '')
  if (s.length === CODE_PREFIX.length + CODE_CHARS && s.startsWith(CODE_PREFIX)) s = s.slice(CODE_PREFIX.length)
  if (s.length !== CODE_CHARS) throw codeError()
  s = s.replace(/[IL]/g, '1').replace(/O/g, '0')
  const out = b4a.alloc(SECRET_BYTES)
  let bits = 0
  let value = 0
  let n = 0
  for (const ch of s) {
    const v = ALPHABET.indexOf(ch)
    if (v === -1) throw codeError()
    value = ((value << 5) | v) & 0xfff
    bits += 5
    if (bits >= 8) {
      out[n++] = (value >>> (bits - 8)) & 0xff
      bits -= 8
    }
  }
  return out
}

/** Normalised form of a code (what formatCode would print), or null if invalid. */
export function normalizeCode (code) {
  try {
    return formatCode(parseCode(code))
  } catch {
    return null
  }
}

export function pairSeedFromSecret (secret) {
  return hcrypto.hash([TAG_PAIR_SEED, checkSecret(secret)])
}

export function authKeyFromSecret (secret) {
  return hcrypto.hash([TAG_PAIR_AUTH, checkSecret(secret)])
}

/**
 * The 32 bytes a pairing client writes first. BLAKE2b has no length extension and
 * the key sits at a fixed position with a fixed length, so this is a sound MAC.
 * The Noise handshake hash is the same on both ends of one connection, different
 * for every other one, and commits to the client's static key.
 */
export function pairProof (authKey, handshakeHash) {
  if (!authKey || authKey.byteLength !== 32) throw new Error('chiave di abbinamento non valida')
  if (!handshakeHash || handshakeHash.byteLength < 32) throw new Error('handshake non completato')
  return hcrypto.hash([TAG_PAIR_PROOF, authKey, handshakeHash])
}

/** Constant-time check of a received proof. */
export function checkPairProof (authKey, handshakeHash, proof) {
  if (!proof || proof.byteLength !== PAIR_PROOF_BYTES) return false
  if (!handshakeHash || handshakeHash.byteLength < 32) return false
  const expected = pairProof(authKey, handshakeHash)
  let diff = 0
  for (let i = 0; i < PAIR_PROOF_BYTES; i++) diff |= expected[i] ^ proof[i]
  return diff === 0
}

/**
 * A name as a u8 length plus UTF-8, cut to MAX_NAME_BYTES on a character boundary.
 * Control characters become spaces.
 */
export function encodeName (name) {
  const clean = String(name || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  let bytes = b4a.from(clean, 'utf8')
  if (bytes.byteLength > MAX_NAME_BYTES) {
    let end = MAX_NAME_BYTES
    // Do not cut a multi-byte character: back off over continuation bytes.
    while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--
    bytes = bytes.subarray(0, end)
  }
  const out = b4a.alloc(1 + bytes.byteLength)
  out[0] = bytes.byteLength
  out.set(bytes, 1)
  return out
}

/** Decode name bytes (without the length byte): cleaned UTF-8, `fallback` if empty. */
export function decodeName (bytes, fallback = '') {
  const s = b4a.toString(bytes, 'utf8').replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  return s || fallback
}

// Accept a key as a 64-char hex string or as 32 bytes; return bytes.
export function toKey (key, what = 'chiave') {
  if (typeof key === 'string') {
    if (!/^[0-9a-fA-F]{64}$/.test(key)) throw new Error(what + ' non valida')
    return b4a.from(key.toLowerCase(), 'hex')
  }
  if (key && key.byteLength === 32) return key
  throw new Error(what + ' non valida')
}

// Same for a secret key (64 bytes, 128 hex chars).
export function toSecretKey (key) {
  if (typeof key === 'string') {
    if (!/^[0-9a-fA-F]{128}$/.test(key)) throw new Error('chiave segreta non valida')
    return b4a.from(key.toLowerCase(), 'hex')
  }
  if (key && key.byteLength === 64) return key
  throw new Error('chiave segreta non valida')
}

export function toKeyPair (keyPair) {
  if (!keyPair) throw new Error('coppia di chiavi mancante')
  return { publicKey: toKey(keyPair.publicKey, 'chiave pubblica'), secretKey: toSecretKey(keyPair.secretKey) }
}

export function errorText (err) {
  if (!err) return null
  return err.code || err.message || String(err)
}
