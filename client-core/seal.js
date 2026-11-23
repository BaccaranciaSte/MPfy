// What only the right devices may read.
//
//   mutes box   = base64(nonce || crypto_secretbox_easy(JSON of the map, nonce, socialKey))
//                 the conversations this profile silenced, for its own devices only:
//                 a source keeps the box and never has the key
//   message box = base64(nonce || crypto_box_easy(plaintext, nonce, recipientChatPublicKey,
//                 senderChatSecretKey)), one per recipient, the writer included
//
// A box is opened with the sender's chat key from the sender's signed card, never
// with a key a source lists. The key of two people is the same in both directions,
// so a box alone does not say who wrote it: the plaintext says it (from, at, the
// conversations), and readMessage checks it against the record it came with.
//
// Portable: sodium-native and b4a.

import sodium from 'sodium-native'
import b4a from 'b4a'

export const NONCE_BYTES = 24
export const MAX_MUTES_BYTES = 64 * 1024
export const MAX_PLAINTEXT_BYTES = 12288
const HEX32_RE = /^[0-9a-f]{32}$/
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

function randomNonce () {
  const nonce = b4a.alloc(NONCE_BYTES)
  sodium.randombytes_buf(nonce)
  return nonce
}

function fromBase64 (box, max) {
  if (typeof box !== 'string' || box.length === 0 || box.length > Math.ceil(max / 3) * 4 || !BASE64_RE.test(box)) return null
  return b4a.from(box, 'base64')
}

function plainObject (v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/**
 * A mutes map as it is kept: conversation id (32 hex) -> until (0: always, else
 * whole milliseconds). Anything else in it is left out.
 */
export function cleanMutes (map) {
  const out = {}
  if (!plainObject(map)) return out
  for (const [cid, until] of Object.entries(map)) {
    if (HEX32_RE.test(cid) && Number.isSafeInteger(until) && until >= 0) out[cid] = until
  }
  return out
}

/** Seal a mutes map for this profile's own devices (`nonce`: tests). */
export function sealMutes (map, socialKey, nonce = randomNonce()) {
  const m = b4a.from(JSON.stringify(map), 'utf8')
  const c = b4a.alloc(m.byteLength + sodium.crypto_secretbox_MACBYTES)
  sodium.crypto_secretbox_easy(c, m, nonce, socialKey)
  return b4a.toString(b4a.concat([nonce, c]), 'base64')
}

/** The mutes map in a box, or null when it does not open with this key or holds no map. */
export function openMutes (box, socialKey) {
  const bytes = fromBase64(box, MAX_MUTES_BYTES)
  if (bytes === null || bytes.byteLength < NONCE_BYTES + sodium.crypto_secretbox_MACBYTES) return null
  const c = bytes.subarray(NONCE_BYTES)
  const m = b4a.alloc(c.byteLength - sodium.crypto_secretbox_MACBYTES)
  let ok = false
  try {
    ok = sodium.crypto_secretbox_open_easy(m, c, bytes.subarray(0, NONCE_BYTES), socialKey)
  } catch {
    ok = false
  }
  if (!ok) return null
  let value = null
  try {
    value = JSON.parse(b4a.toString(m, 'utf8'))
  } catch {
    return null
  }
  return plainObject(value) ? cleanMutes(value) : null
}

/**
 * The box of a message for one recipient: `plaintext` (a string or bytes, at most
 * 12,288 bytes), the recipient's chat public key, the sender's chat secret key
 * (`nonce`: tests).
 */
export function sealBox (plaintext, recipientPublicKey, senderSecretKey, nonce = randomNonce()) {
  const m = typeof plaintext === 'string' ? b4a.from(plaintext, 'utf8') : plaintext
  if (m.byteLength < 1 || m.byteLength > MAX_PLAINTEXT_BYTES) throw new RangeError('message too long')
  const c = b4a.alloc(m.byteLength + sodium.crypto_box_MACBYTES)
  sodium.crypto_box_easy(c, m, nonce, recipientPublicKey, senderSecretKey)
  return b4a.toString(b4a.concat([nonce, c]), 'base64')
}

/** The plaintext bytes of a box, or null when it does not open with these keys. */
export function openBox (box, senderPublicKey, recipientSecretKey) {
  const bytes = fromBase64(box, NONCE_BYTES + sodium.crypto_box_MACBYTES + MAX_PLAINTEXT_BYTES)
  if (bytes === null || bytes.byteLength <= NONCE_BYTES + sodium.crypto_box_MACBYTES) return null
  const c = bytes.subarray(NONCE_BYTES)
  const m = b4a.alloc(c.byteLength - sodium.crypto_box_MACBYTES)
  let ok = false
  try {
    ok = sodium.crypto_box_open_easy(m, c, bytes.subarray(0, NONCE_BYTES), senderPublicKey, recipientSecretKey)
  } catch {
    ok = false
  }
  return ok ? m : null
}

/**
 * The message a box held, when it belongs where it was found: valid JSON of at
 * most 12,288 bytes, version 1, the id, sender and time of its record, and the
 * conversation it was read from among its own. Anything else is null (the message
 * is dropped): a source cannot move a box to another conversation, id, sender or
 * time, nor hand a person's own box back to them as someone else's.
 */
export function readMessage (plaintext, { id, from, at, conversation }) {
  if (plaintext === null || plaintext.byteLength > MAX_PLAINTEXT_BYTES) return null
  let msg = null
  try {
    msg = JSON.parse(b4a.toString(plaintext, 'utf8'))
  } catch {
    return null
  }
  if (!plainObject(msg) || msg.v !== 1) return null
  if (msg.id !== id || msg.from !== from || msg.at !== at) return null
  if (!Array.isArray(msg.c) || !msg.c.includes(conversation)) return null
  return msg
}
