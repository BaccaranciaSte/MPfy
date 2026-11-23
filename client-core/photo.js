// The profile photo in the client core: a JPEG the page makes (320 x 320 px,
// usually 10-35 KB), named by its SHA-256 (64 hex) and kept next to the state
// file as <state file name>.photo-<hash>.jpg (state.json.photo-<hash>.jpg). The
// state holds the hash and its time; a file of this state file the state does not
// point to is removed (sweepPhotos). Another state file in the same folder (a
// second client on the same computer) has its own names, never touched here.
//
// Written atomically like the state file (temporary file, flush, rename). Read
// back only when its bytes still pass the checks and hash to its name.
//
// Portable: '#fs' and '#path' import maps, b4a, sodium-native.

import fs from '#fs'
import path from '#path'
import b4a from 'b4a'
import sodium from 'sodium-native'
import { writeFileAtomic } from './state.js'

export const MAX_PHOTO_BYTES = 48 * 1024
const HEX64_RE = /^[0-9a-f]{64}$/
// What follows the prefix in a photo file's name, or in the temporary file of one
// a crash left behind.
const FILE_RE = /^([0-9a-f]{64})\.jpg(\.tmp)?$/

/** A JPEG as the sources take it: 1 to 48 KB, FF D8 FF in front, FF D9 at the end. */
export function validPhoto (bytes) {
  if (bytes === null || typeof bytes !== 'object' || typeof bytes.byteLength !== 'number') return false
  const n = bytes.byteLength
  return n >= 1 && n <= MAX_PHOTO_BYTES &&
    bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes[n - 2] === 0xff && bytes[n - 1] === 0xd9
}

/** The SHA-256 of the bytes, 64 lower-case hex. */
export function photoHash (bytes) {
  const out = b4a.alloc(sodium.crypto_hash_sha256_BYTES)
  sodium.crypto_hash_sha256(out, bytes)
  return b4a.toString(out, 'hex')
}

export function isPhotoHash (value) {
  return typeof value === 'string' && HEX64_RE.test(value)
}

/**
 * Whether the photo `hash` (null: none) set at `at` wins over `thanHash` set at
 * `than`: the newer time, and at the very same time the greater hash, none below
 * any photo. The sources keep the same rule, so devices that changed the photo in
 * the same millisecond still end on one.
 */
export function photoWins (at, hash, than, thanHash) {
  return at > than || (at === than && (hash || '') > (thanHash || ''))
}

// The start of the name of every photo file of this state file.
function prefixOf (statePath) {
  return path.basename(statePath) + '.photo-'
}

/** Where the photo with this hash lives: next to the state file. */
export function photoPath (statePath, hash) {
  return path.join(path.dirname(statePath), prefixOf(statePath) + hash + '.jpg')
}

/** Write the photo's file (atomically). */
export function writePhoto (statePath, hash, bytes) {
  return writeFileAtomic(photoPath(statePath, hash), bytes)
}

/**
 * The bytes of the photo with this hash, or null when its file is missing or no
 * longer holds a valid photo with that hash. Any other error (the file held by
 * another program for a moment, as an antivirus does on Windows) is thrown: that
 * photo is not lost.
 */
export function readPhoto (statePath, hash) {
  if (!isPhotoHash(hash)) return null
  let bytes
  try {
    bytes = fs.readFileSync(photoPath(statePath, hash))
  } catch (err) {
    if (err && err.code === 'ENOENT') return null
    throw err
  }
  return validPhoto(bytes) && photoHash(bytes) === hash ? bytes : null
}

export function removePhoto (statePath, hash) {
  try {
    fs.unlinkSync(photoPath(statePath, hash))
  } catch {}
}

/**
 * Remove every photo file of this state file but the one with hash `keep` (null:
 * all of them), temporary files included. Never throws.
 */
export function sweepPhotos (statePath, keep) {
  const dir = path.dirname(statePath)
  const prefix = prefixOf(statePath)
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue
    const m = FILE_RE.exec(name.slice(prefix.length))
    if (m === null || (m[1] === keep && m[2] === undefined)) continue
    try {
      fs.unlinkSync(path.join(dir, name))
    } catch {}
  }
}
