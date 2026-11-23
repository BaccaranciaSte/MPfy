// A person's identity in the client core: the profile keys made from one secret,
// the proof sent to every source, the profile code, the identity file (.mpfy) and
// the optional password recovery. The sources check the same bytes.
//
//   signSeed   = BLAKE2b-256("mpfy/profile-sign/1" || profileSecret)   Ed25519 seed
//   profileId  = hex(first 16 bytes of BLAKE2b-256("mpfy/profile-id/1" || signPublicKey))
//   chatSeed   = BLAKE2b-256("mpfy/chat-key/1" || profileSecret)       X25519 seed (crypto_box)
//   socialKey  = BLAKE2b-256("mpfy/social-box/1" || profileSecret)     crypto_secretbox key for
//                what only this profile's own devices read
//   profile ID = the first 40 bits of the profileId in Crockford base32, "XXXX-XXXX"
//                (what people see and search; public and harmless)
//   proof      = hex(signPublicKey || sign("mpfy/profile/1" || clientKey || serverKey))
//   code       = "MPFY-P-" + Crockford base32 of (secret || 3-byte check), 14 groups of 4
//   recovery   = Argon2id(password, salt, 3, 64 MiB) -> encKey || verifierKey;
//                blob = 0x01 || nonce || XChaCha20-Poly1305(identity, "mpfy/recovery/1" || id)
//
// Portable: sodium-native and b4a.

import sodium from 'sodium-native'
import b4a from 'b4a'

const TAG_SIGN = b4a.from('mpfy/profile-sign/1')
const TAG_ID = b4a.from('mpfy/profile-id/1')
const TAG_PROOF = b4a.from('mpfy/profile/1')
const TAG_CODE = b4a.from('mpfy/profile-code/1')
const TAG_VERIFIER = b4a.from('mpfy/recovery-verifier/1')
const TAG_RECOVERY = b4a.from('mpfy/recovery/1')
const TAG_CHAT = b4a.from('mpfy/chat-key/1')
const TAG_SOCIAL = b4a.from('mpfy/social-box/1')

export const SECRET_BYTES = 32
export const OPSLIMIT = 3
export const MEMLIMIT = 67108864
export const MIN_PASSWORD_CHARS = 8
export const MAX_BLOB_BYTES = 65536
export const MAX_PROFILE_NAME_CHARS = 40
export const IDENTITY_FORMAT = 'mpfy-identity'

const CHECK_BYTES = 3
const CODE_CHARS = 56 // (32 + 3) bytes * 8 bits / 5 bits per character
const CODE_PREFIX = 'MPFY-P-'
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const BLOB_VERSION = 1
const NONCE_BYTES = 24
const TAG_BYTES = 16

const HEX32_RE = /^[0-9a-f]{32}$/
const HEX64_RE = /^[0-9a-f]{64}$/
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
// What a pasted code may carry between its characters: spaces, dashes (also the
// typographic ones a phone keyboard puts in) and underscores.
const SEPARATORS_RE = /[\s\-_\u2010-\u2015\u2212]/g
// Characters a file name cannot hold on Windows or Android, and controls.
const FILE_BAD_RE = /[\\/:*?"<>|\u0000-\u001f\u007f-\u009f]/g
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g
const MAX_FILE_NAME_CHARS = 60

let pwhashRuns = 0

export function blake2b256 (...parts) {
  const out = b4a.alloc(32)
  sodium.crypto_generichash(out, b4a.concat(parts))
  return out
}

export function randomBytes (n) {
  const out = b4a.alloc(n)
  sodium.randombytes_buf(out)
  return out
}

/** A new profile secret (32 random bytes). */
export function newProfileSecret () {
  return randomBytes(SECRET_BYTES)
}

function toBytes (value, n, what) {
  if (typeof value === 'string') {
    if (value.length !== n * 2 || !/^[0-9a-fA-F]+$/.test(value)) throw new Error(what + ' non valido')
    return b4a.from(value.toLowerCase(), 'hex')
  }
  if (value && value.byteLength === n) return value
  throw new Error(what + ' non valido')
}

/**
 * The keys of a profile secret (32 bytes or 64 hex): { id, secret (hex), signSeed,
 * signPublicKey, signSecretKey, chatPublicKey, chatSecretKey, socialKey } (keys as
 * bytes). The secret keys never leave the device: they are made again from the
 * secret at every start, never stored.
 */
export function profileKeys (secret) {
  const s = toBytes(secret, SECRET_BYTES, 'segreto del profilo')
  const signSeed = blake2b256(TAG_SIGN, s)
  const signPublicKey = b4a.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
  const signSecretKey = b4a.alloc(sodium.crypto_sign_SECRETKEYBYTES)
  sodium.crypto_sign_seed_keypair(signPublicKey, signSecretKey, signSeed)
  const chatPublicKey = b4a.alloc(sodium.crypto_box_PUBLICKEYBYTES)
  const chatSecretKey = b4a.alloc(sodium.crypto_box_SECRETKEYBYTES)
  sodium.crypto_box_seed_keypair(chatPublicKey, chatSecretKey, blake2b256(TAG_CHAT, s))
  return {
    id: profileIdOf(signPublicKey),
    secret: b4a.toString(s, 'hex'),
    signSeed,
    signPublicKey,
    signSecretKey,
    chatPublicKey,
    chatSecretKey,
    socialKey: blake2b256(TAG_SOCIAL, s)
  }
}

/**
 * The profile ID of a profileId (32 hex): its first 5 bytes as a 40 bit number,
 * 8 Crockford base32 digits, most significant first, as "XXXX-XXXX". null for
 * anything that is not a profileId.
 */
export function profileIdText (profileId) {
  if (typeof profileId !== 'string' || !HEX32_RE.test(profileId)) return null
  // 40 bits: exact in a double, no BigInt needed.
  let v = parseInt(profileId.slice(0, 10), 16)
  let out = ''
  for (let i = 0; i < 8; i++) {
    out = ALPHABET[v % 32] + out
    v = Math.floor(v / 32)
  }
  return out.slice(0, 4) + '-' + out.slice(4)
}

export function profileIdOf (signPublicKey) {
  return b4a.toString(blake2b256(TAG_ID, signPublicKey).subarray(0, 16), 'hex')
}

/**
 * The X-MPfy-Profile-Proof value for this device on this source (192 hex). The
 * signature is deterministic: the same inputs give the same value.
 */
export function proofValue (keys, clientPublicKey, serverPublicKey) {
  const message = b4a.concat([TAG_PROOF, toBytes(clientPublicKey, 32, 'chiave del dispositivo'), toBytes(serverPublicKey, 32, 'chiave della fonte')])
  const signature = b4a.alloc(sodium.crypto_sign_BYTES)
  sodium.crypto_sign_detached(signature, message, keys.signSecretKey)
  return b4a.toString(b4a.concat([keys.signPublicKey, signature]), 'hex')
}

/** Both profile headers, as sent to a source. */
export function proofHeaders (keys, clientPublicKey, serverPublicKey) {
  return { 'X-MPfy-Profile': keys.id, 'X-MPfy-Profile-Proof': proofValue(keys, clientPublicKey, serverPublicKey) }
}

// ------------------------------------------------------------- profile code

function codeCheck (secret) {
  return blake2b256(TAG_CODE, secret).subarray(0, CHECK_BYTES)
}

function base32 (bytes) {
  let bits = 0
  let value = 0
  let out = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    value = ((value << 8) | bytes[i]) & 0xffff
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  return out
}

/** secret (32 bytes or 64 hex) -> "MPFY-P-XXXX-...": 56 characters in 14 groups of 4. */
export function formatProfileCode (secret) {
  const s = toBytes(secret, SECRET_BYTES, 'segreto del profilo')
  const chars = base32(b4a.concat([s, codeCheck(s)]))
  const groups = []
  for (let i = 0; i < chars.length; i += 4) groups.push(chars.slice(i, i + 4))
  return CODE_PREFIX + groups.join('-')
}

function squeeze (code) {
  return code.toUpperCase().replace(SEPARATORS_RE, '')
}

/**
 * Which code this is, by its length once the separators are gone: 'source'
 * (36 or 32), 'profile' (61 or 56), or null.
 */
export function codeKind (code) {
  if (typeof code !== 'string') return null
  const n = squeeze(code).length
  if (n === 36 || n === 32) return 'source'
  if (n === 61 || n === 56) return 'profile'
  return null
}

/**
 * A profile code as typed or pasted -> the secret (32 bytes), or null when it is
 * not a valid profile code (length, a character outside the alphabet, the check).
 */
export function parseProfileCode (code) {
  if (typeof code !== 'string') return null
  let s = squeeze(code)
  if (s.length === CODE_CHARS + 5 && s.startsWith('MPFYP')) s = s.slice(5)
  if (s.length !== CODE_CHARS) return null
  s = s.replace(/[IL]/g, '1').replace(/O/g, '0')
  const out = b4a.alloc(SECRET_BYTES + CHECK_BYTES)
  let bits = 0
  let value = 0
  let n = 0
  for (const ch of s) {
    const v = ALPHABET.indexOf(ch)
    if (v === -1) return null
    value = ((value << 5) | v) & 0xfff
    bits += 5
    if (bits >= 8) {
      out[n++] = (value >>> (bits - 8)) & 0xff
      bits -= 8
    }
  }
  const secret = out.subarray(0, SECRET_BYTES)
  if (!b4a.equals(codeCheck(secret), out.subarray(SECRET_BYTES))) return null
  return b4a.from(secret)
}

// ------------------------------------------------------------------- names

/**
 * A profile name as the sources take it: control characters removed, spaces
 * collapsed, trimmed, 1 to 40 code points. null when it does not fit.
 */
export function cleanProfileName (value) {
  if (typeof value !== 'string') return null
  const s = value.replace(CONTROL_RE, '').replace(/\s+/gu, ' ').trim()
  const n = Array.from(s).length
  return n >= 1 && n <= MAX_PROFILE_NAME_CHARS ? s : null
}

// The name stored with a profile: the same cleanup, "" allowed, cut at 40.
function storedProfileName (value) {
  if (typeof value !== 'string') return ''
  const s = value.replace(CONTROL_RE, '').replace(/\s+/gu, ' ').trim()
  return Array.from(s).slice(0, MAX_PROFILE_NAME_CHARS).join('').trim()
}

/** The name of the identity file of a profile called `name`. */
export function identityFileName (name) {
  // Dots in front make a hidden file: they go with the spaces among them.
  let s = typeof name === 'string' ? name.replace(FILE_BAD_RE, '').replace(/^[\s.]+/u, '').trim() : ''
  s = Array.from(s).slice(0, MAX_FILE_NAME_CHARS).join('').trim()
  return (s === '' ? 'MPfy' : s) + '.mpfy'
}

// --------------------------------------------------------------- the file

/**
 * The identity of a state (it must have a profile), as the .mpfy file holds it.
 * withRecovery false: recovery null (the plaintext of a recovery blob).
 */
export function buildIdentity (state, { withRecovery = true, exportedAt = Date.now() } = {}) {
  const p = state.profile
  const r = withRecovery ? state.recovery : null
  return {
    format: IDENTITY_FORMAT,
    v: 1,
    profile: { id: p.id, secret: p.secret, name: p.name, nameUpdatedAt: p.nameUpdatedAt },
    clientSeed: state.clientSeed,
    sources: state.sources.map((s) => ({ id: s.id, name: s.name, serverPublicKey: s.serverPublicKey, principal: s.principal, addedAt: s.addedAt })),
    recovery: r === null ? null : { salt: r.salt, opslimit: r.opslimit, memlimit: r.memlimit, encKey: r.encKey, verifierHash: r.verifierHash, updatedAt: r.updatedAt },
    exportedAt
  }
}

export function identityText (identity) {
  return JSON.stringify(identity, null, 2) + '\n'
}

/** A recovery record as the state and the file keep it, or null when anything is off. */
export function normalizeRecovery (r) {
  if (r === null || typeof r !== 'object' || Array.isArray(r)) return null
  const salt = typeof r.salt === 'string' ? r.salt.toLowerCase() : ''
  const encKey = typeof r.encKey === 'string' ? r.encKey.toLowerCase() : ''
  const verifierHash = typeof r.verifierHash === 'string' ? r.verifierHash.toLowerCase() : ''
  if (!HEX32_RE.test(salt) || !HEX64_RE.test(encKey) || !HEX64_RE.test(verifierHash)) return null
  if (r.opslimit !== OPSLIMIT || r.memlimit !== MEMLIMIT) return null
  const updatedAt = wholeTime(r.updatedAt)
  if (updatedAt === null) return null
  return { salt, opslimit: OPSLIMIT, memlimit: MEMLIMIT, encKey, verifierHash, updatedAt }
}

// A stored time in whole milliseconds, or null. Past 2^53 adding one changes
// nothing, so a time there could never be followed by a newer one.
export function wholeTime (value) {
  if (typeof value !== 'number' || !(value >= 0)) return null
  const t = Math.floor(value)
  return Number.isSafeInteger(t) ? t : null
}

/**
 * A profile as the state keeps it, from its stored form: the id always follows
 * from the secret. null when the secret is unusable.
 */
export function normalizeProfile (p, now = Date.now()) {
  if (p === null || typeof p !== 'object' || Array.isArray(p)) return null
  const secret = typeof p.secret === 'string' ? p.secret.toLowerCase() : ''
  if (!HEX64_RE.test(secret)) return null
  return {
    id: profileKeys(secret).id,
    secret,
    name: storedProfileName(p.name),
    nameUpdatedAt: wholeTime(p.nameUpdatedAt) || 0,
    createdAt: Number.isFinite(p.createdAt) && p.createdAt > 0 ? Math.floor(p.createdAt) : now
  }
}

/**
 * Read an identity (the parsed JSON of a .mpfy file or of a recovery blob).
 * Returns { profile, clientSeed, sources, recovery } with the sources still to
 * normalize like the state file, or null when it is not a valid identity.
 */
export function parseIdentity (value) {
  let obj = value
  if (typeof obj === 'string') {
    try {
      obj = JSON.parse(obj.charCodeAt(0) === 0xfeff ? obj.slice(1) : obj)
    } catch {
      return null
    }
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null
  if (obj.format !== IDENTITY_FORMAT || obj.v !== 1) return null
  const p = obj.profile
  if (p === null || typeof p !== 'object' || Array.isArray(p)) return null
  const profile = normalizeProfile(p)
  if (profile === null) return null
  if (typeof p.id !== 'string' || p.id.toLowerCase() !== profile.id) return null
  if (p.name !== undefined && typeof p.name !== 'string') return null
  const clientSeed = typeof obj.clientSeed === 'string' ? obj.clientSeed.toLowerCase() : ''
  if (!HEX64_RE.test(clientSeed)) return null
  if (!Array.isArray(obj.sources)) return null
  let recovery = null
  if (obj.recovery !== null && obj.recovery !== undefined) {
    recovery = normalizeRecovery(obj.recovery)
    if (recovery === null) return null
  }
  return { profile, clientSeed, sources: obj.sources, recovery }
}

// ---------------------------------------------------------------- recovery

/** At least 8 characters (code points) once normalized. */
export function passwordLongEnough (password) {
  return typeof password === 'string' && Array.from(password.normalize('NFC')).length >= MIN_PASSWORD_CHARS
}

/**
 * Argon2id of a password (always the asynchronous call: the synchronous one
 * would hold the local HTTP server for about a second).
 * @returns {Promise<{ encKey: Uint8Array, verifierKey: Uint8Array, verifierHash: Uint8Array }>}
 */
export async function deriveRecoveryKeys (password, salt) {
  const s = toBytes(salt, sodium.crypto_pwhash_SALTBYTES, 'sale')
  const pw = b4a.from(String(password).normalize('NFC'), 'utf8')
  const out = b4a.alloc(64)
  pwhashRuns++
  try {
    await sodium.crypto_pwhash_async(out, pw, s, OPSLIMIT, MEMLIMIT, sodium.crypto_pwhash_ALG_ARGON2ID13)
  } finally {
    sodium.sodium_memzero(pw)
  }
  const encKey = b4a.from(out.subarray(0, 32))
  const verifierKey = b4a.from(out.subarray(32, 64))
  sodium.sodium_memzero(out)
  return { encKey, verifierKey, verifierHash: blake2b256(TAG_VERIFIER, verifierKey) }
}

/** How many times Argon2id has run in this process. */
export function pwhashCount () {
  return pwhashRuns
}

export function verifierHashOf (verifierKey) {
  return blake2b256(TAG_VERIFIER, verifierKey)
}

function recoveryAd (profileId) {
  return b4a.concat([TAG_RECOVERY, toBytes(profileId, 16, 'profilo')])
}

/** Encrypt an identity text for the sources: base64 of 0x01 || nonce || ciphertext. */
export function encryptBlob (text, encKey, profileId) {
  const m = b4a.from(text, 'utf8')
  const nonce = randomBytes(NONCE_BYTES)
  const c = b4a.alloc(m.byteLength + TAG_BYTES)
  sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(c, m, recoveryAd(profileId), null, nonce, toBytes(encKey, 32, 'chiave'))
  const blob = b4a.concat([b4a.from([BLOB_VERSION]), nonce, c])
  if (blob.byteLength > MAX_BLOB_BYTES) throw new Error('identita\' troppo grande per il recupero')
  return b4a.toString(blob, 'base64')
}

/** The identity text inside a blob, or null when it does not open with this key. */
export function decryptBlob (blobBase64, encKey, profileId) {
  if (typeof blobBase64 !== 'string' || !BASE64_RE.test(blobBase64)) return null
  const blob = b4a.from(blobBase64, 'base64')
  if (blob.byteLength > MAX_BLOB_BYTES || blob.byteLength < 1 + NONCE_BYTES + TAG_BYTES || blob[0] !== BLOB_VERSION) return null
  const nonce = blob.subarray(1, 1 + NONCE_BYTES)
  const c = blob.subarray(1 + NONCE_BYTES)
  const m = b4a.alloc(c.byteLength - TAG_BYTES)
  try {
    sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(m, null, c, recoveryAd(profileId), nonce, toBytes(encKey, 32, 'chiave'))
  } catch {
    return null
  }
  return b4a.toString(m, 'utf8')
}
