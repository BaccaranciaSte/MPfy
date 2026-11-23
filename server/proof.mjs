// Profile identity on the source side: the id a signing key stands for, the
// check of the X-MPfy-Profile-Proof header, and the recovery verifier hash.
// Byte for byte the same as the client core (sodium-native).
//
//   profileId = hex(first 16 bytes of BLAKE2b-256("mpfy/profile-id/1" || signPublicKey))
//   proof     = hex(signPublicKey || Ed25519 signature of
//               "mpfy/profile/1" || clientPublicKey || serverPublicKey)

import sodium from 'sodium-native'

const TAG_PROFILE_ID = Buffer.from('mpfy/profile-id/1', 'ascii')
const TAG_PROOF = Buffer.from('mpfy/profile/1', 'ascii')
const TAG_VERIFIER = Buffer.from('mpfy/recovery-verifier/1', 'ascii')

const PROFILE_HEX = /^[0-9a-f]{32}$/
const PROOF_HEX = /^[0-9a-f]{192}$/

export function blake2b256 (...parts) {
  const out = Buffer.alloc(32)
  sodium.crypto_generichash(out, Buffer.concat(parts))
  return out
}

/** profileId (32 hex) of an Ed25519 public key (32 bytes). */
export function profileIdOf (signPublicKey) {
  return blake2b256(TAG_PROFILE_ID, signPublicKey).subarray(0, 16).toString('hex')
}

/**
 * Check the two profile headers of a request that came over the P2P link of
 * `clientKeyHex`, for this source's `serverKeyHex`. Returns
 * { profileId, signPublicKey } (hex) or null when anything is wrong.
 */
export function checkProof (profileHeader, proofHeader, clientKeyHex, serverKeyHex) {
  if (typeof profileHeader !== 'string' || typeof proofHeader !== 'string') return null
  const profileId = profileHeader.trim().toLowerCase()
  const proofHex = proofHeader.trim().toLowerCase()
  if (!PROFILE_HEX.test(profileId) || !PROOF_HEX.test(proofHex)) return null
  if (typeof clientKeyHex !== 'string' || typeof serverKeyHex !== 'string') return null
  const proof = Buffer.from(proofHex, 'hex')
  const signPublicKey = proof.subarray(0, 32)
  const signature = proof.subarray(32)
  if (profileIdOf(signPublicKey) !== profileId) return null
  const message = Buffer.concat([TAG_PROOF, Buffer.from(clientKeyHex, 'hex'), Buffer.from(serverKeyHex, 'hex')])
  if (message.length !== 78) return null
  let ok = false
  try {
    ok = sodium.crypto_sign_verify_detached(signature, message, signPublicKey)
  } catch {
    ok = false
  }
  return ok ? { profileId, signPublicKey: signPublicKey.toString('hex') } : null
}

/** BLAKE2b-256("mpfy/recovery-verifier/1" || verifierKey). */
export function verifierHashOf (verifierKey) {
  return blake2b256(TAG_VERIFIER, verifierKey)
}

/** Constant-time comparison of two equally long buffers. */
export function sameBytes (a, b) {
  return a.length === b.length && sodium.sodium_memcmp(a, b)
}
