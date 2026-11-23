// The client core's state file:
//   { clientSeed, profile, recovery, recoveryDeletes, social,
//     sources: [{ id, name, serverPublicKey, principal, addedAt, role, named, profiles,
//                 social, card }] }
// - clientSeed: 32 random bytes (hex); the one client key pair used with every source.
// - profile: null or { id, secret, name, nameUpdatedAt, createdAt, photo,
//   photoUpdatedAt }: the person. The id always follows from the secret
//   (identity.js). photo: null or the SHA-256 (64 hex) of the profile photo, whose
//   bytes are <this file's name>.photo-<hash>.jpg next to this file (photo.js);
//   photoUpdatedAt: whole milliseconds, 0 when never set (a removal has a time
//   too). A file written before photos reads as null and 0. The identity file
//   never holds either.
// - recovery: null or { salt, opslimit, memlimit, encKey, verifierHash, updatedAt }:
//   the key derived from the recovery password, never the password itself.
// - recoveryDeletes: ids of the sources that still have to drop this device's
//   recovery blob (recovery turned off while they were away).
// - social: this profile's own social settings, each section with its time (the
//   newest wins, between devices as for the name):
//   { privacy: { invisible, showNow, privateUntil, showRecent, updatedAt },
//     blocked: { ids, updatedAt }, mutes: { map: { <conversation id>: until }, updatedAt } }.
//   Never in the identity file or the recovery blob: the sources give them back.
// - id: first 8 hex characters of the source's public key.
// - role, named: what the source said at the last sync; null when unknown (a
//   source without profiles).
// - profiles: true when the source has profiles (it answered GET /api/profile),
//   false when it has none (404 there), null until a sync tells.
// - social: the social part the source speaks (1 people, 2 chats, 3 songs; 0 when
//   it has none), null until a sync tells.
// - card: the signature of this profile's card the source said it keeps, or null.
// - exactly one source is principal when any exists (the first added, until changed).
//
// Written atomically: a temporary file next to it (0600), flushed to disk, then
// renamed over the old one, so a crash leaves either the old state or the new one,
// never half a file. A file that cannot be parsed is set aside (renamed to
// <name>.corrupt-<time>) and a new state begins.
//
// Portable: '#fs' and '#path' import maps, b4a.

import fs from '#fs'
import path from '#path'
import b4a from 'b4a'
import { generateKeyPair } from '../transport/client.js'
import { normalizeProfile, normalizeRecovery, wholeTime } from './identity.js'

const HEX64_RE = /^[0-9a-f]{64}$/
const SOURCE_ID_RE = /^[0-9a-f]{8}$/
const ROLES = new Set(['owner', 'member', 'guest'])
const HEX32_RE = /^[0-9a-f]{32}$/
const SIG_RE = /^[0-9a-f]{128}$/
export const MAX_NAME_CHARS = 60
// C0 and C1 controls and the two Unicode line separators (built from code points
// so the source file itself stays plain ASCII).
const CONTROL_RE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f' + String.fromCharCode(0x2028, 0x2029) + ']', 'g')
// Errors a rename may hit on Windows while another process (an antivirus scan,
// an indexer) holds the target open for a moment: worth a few retries.
const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])

export function sourceIdOf (serverPublicKey) {
  return serverPublicKey.slice(0, 8)
}

/**
 * A display name: control characters removed, spaces collapsed, at most 60
 * characters. Empty string when nothing is left.
 */
export function cleanName (value) {
  if (typeof value !== 'string') return ''
  const chars = Array.from(value.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim())
  return chars.slice(0, MAX_NAME_CHARS).join('').trim()
}

export function newState () {
  return { clientSeed: generateKeyPair().seed, profile: null, recovery: null, recoveryDeletes: [], social: defaultSocial(), sources: [] }
}

export function cloneState (state) {
  return {
    clientSeed: state.clientSeed,
    profile: state.profile === null ? null : { ...state.profile },
    recovery: state.recovery === null ? null : { ...state.recovery },
    recoveryDeletes: state.recoveryDeletes.slice(),
    social: cloneSocial(state.social),
    sources: state.sources.map((s) => ({ ...s }))
  }
}

/** The social settings of a profile nobody changed yet. */
export function defaultSocial () {
  return {
    privacy: { invisible: false, showNow: true, privateUntil: 0, showRecent: true, updatedAt: 0 },
    blocked: { ids: [], updatedAt: 0 },
    mutes: { map: {}, updatedAt: 0 }
  }
}

export function cloneSocial (s) {
  return { privacy: { ...s.privacy }, blocked: { ids: s.blocked.ids.slice(), updatedAt: s.blocked.updatedAt }, mutes: { map: { ...s.mutes.map }, updatedAt: s.mutes.updatedAt } }
}

/** The social settings as the state keeps them, from their stored form. */
export function normalizeSocial (raw) {
  const out = defaultSocial()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  const p = raw.privacy
  if (p !== null && typeof p === 'object' && !Array.isArray(p)) {
    for (const k of ['invisible', 'showNow', 'showRecent']) if (typeof p[k] === 'boolean') out.privacy[k] = p[k]
    out.privacy.privateUntil = wholeTime(p.privateUntil) || 0
    out.privacy.updatedAt = wholeTime(p.updatedAt) || 0
  }
  const b = raw.blocked
  if (b !== null && typeof b === 'object' && !Array.isArray(b)) {
    if (Array.isArray(b.ids)) out.blocked.ids = [...new Set(b.ids.filter((id) => typeof id === 'string' && HEX32_RE.test(id)))]
    out.blocked.updatedAt = wholeTime(b.updatedAt) || 0
  }
  const m = raw.mutes
  if (m !== null && typeof m === 'object' && !Array.isArray(m)) {
    if (m.map !== null && typeof m.map === 'object' && !Array.isArray(m.map)) {
      for (const [cid, until] of Object.entries(m.map)) if (HEX32_RE.test(cid) && wholeTime(until) !== null) out.mutes.map[cid] = wholeTime(until)
    }
    out.mutes.updatedAt = wholeTime(m.updatedAt) || 0
  }
  return out
}

/** A source's role as the state keeps it. */
export function roleOf (value) {
  return ROLES.has(value) ? value : null
}

// A file written before `profiles` existed: a role was only ever stored from a
// source with profiles.
function profilesOf (s) {
  if (typeof s.profiles === 'boolean') return s.profiles
  return s.profiles === undefined && roleOf(s.role) !== null ? true : null
}

/**
 * The sources of a state or of an identity file, repaired: ids from the keys,
 * duplicates and entries without a usable key dropped, names cleaned, one
 * principal. Returns { sources, changed }.
 */
export function normalizeSources (list, now = Date.now()) {
  const sources = []
  const seen = new Set()
  let changed = !Array.isArray(list)
  for (const s of Array.isArray(list) ? list : []) {
    const key = s && typeof s.serverPublicKey === 'string' ? s.serverPublicKey.toLowerCase() : ''
    if (!HEX64_RE.test(key) || seen.has(key) || seen.has(sourceIdOf(key))) {
      changed = true
      continue
    }
    seen.add(key)
    seen.add(sourceIdOf(key))
    const entry = {
      id: sourceIdOf(key),
      name: cleanName(s.name) || 'Fonte',
      serverPublicKey: key,
      principal: s.principal === true,
      addedAt: Number.isFinite(s.addedAt) && s.addedAt > 0 ? Math.floor(s.addedAt) : now,
      role: roleOf(s.role),
      named: typeof s.named === 'boolean' ? s.named : null,
      profiles: profilesOf(s),
      social: Number.isSafeInteger(s.social) && s.social >= 0 ? s.social : null,
      card: typeof s.card === 'string' && SIG_RE.test(s.card) ? s.card : null
    }
    for (const k of Object.keys(entry)) if (entry[k] !== s[k]) changed = true
    if (Object.keys(s).length !== Object.keys(entry).length) changed = true
    sources.push(entry)
  }
  if (fixPrincipal(sources)) changed = true
  return { sources, changed }
}

/**
 * Repair what can be repaired in a parsed state. Returns null when the client
 * seed is unusable (the state is worth nothing without it). A state written
 * before profiles loads with profile null.
 * @returns {{ state: object, changed: boolean } | null}
 */
export function normalizeState (raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const seed = typeof raw.clientSeed === 'string' ? raw.clientSeed.toLowerCase() : ''
  if (!HEX64_RE.test(seed)) return null
  let changed = seed !== raw.clientSeed
  const { sources, changed: sourcesChanged } = normalizeSources(raw.sources)
  if (sourcesChanged) changed = true

  const profile = stateProfile(raw.profile === undefined ? null : raw.profile)
  if (!sameFields(profile, raw.profile)) changed = true
  const recovery = profile === null ? null : normalizeRecovery(raw.recovery === undefined ? null : raw.recovery)
  if (!sameFields(recovery, raw.recovery)) changed = true

  const recoveryDeletes = []
  const ids = new Set(sources.map((s) => s.id))
  const list = Array.isArray(raw.recoveryDeletes) ? raw.recoveryDeletes : []
  if (!Array.isArray(raw.recoveryDeletes)) changed = true
  for (const id of list) {
    if (profile !== null && typeof id === 'string' && SOURCE_ID_RE.test(id) && ids.has(id) && !recoveryDeletes.includes(id)) recoveryDeletes.push(id)
    else changed = true
  }
  // The settings belong to the profile: none without one.
  const social = profile === null ? defaultSocial() : normalizeSocial(raw.social)
  if (JSON.stringify(social) !== JSON.stringify(raw.social)) changed = true
  return { state: { clientSeed: seed, profile, recovery, recoveryDeletes, social, sources }, changed }
}

// The profile as the state keeps it: the identity's fields, then the photo's.
function stateProfile (raw) {
  const profile = normalizeProfile(raw)
  if (profile === null) return null
  const photo = typeof raw.photo === 'string' ? raw.photo.toLowerCase() : ''
  profile.photo = HEX64_RE.test(photo) ? photo : null
  profile.photoUpdatedAt = wholeTime(raw.photoUpdatedAt) || 0
  return profile
}

// The same fields with the same values (a record read back exactly as stored).
function sameFields (a, b) {
  if (a === null || b === null || b === undefined) return a === null && b === null
  if (typeof b !== 'object' || Array.isArray(b)) return false
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k])
}

/** Exactly one principal when any source exists: keep the first marked, else the first. */
export function fixPrincipal (sources) {
  let changed = false
  let found = false
  for (const s of sources) {
    if (s.principal && !found) {
      found = true
    } else if (s.principal) {
      s.principal = false
      changed = true
    }
  }
  if (!found && sources.length > 0) {
    sources[0].principal = true
    changed = true
  }
  return changed
}

/**
 * Read the state file. A missing file gives a new state; one that does not parse
 * (or has no usable seed) is set aside and a new state begins.
 * @returns {{ state: object, changed: boolean, setAside: string|null }}
 *   changed: the state differs from the file (or there is no file): save it
 */
export function readStateFile (statePath) {
  let text
  try {
    text = b4a.toString(fs.readFileSync(statePath), 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') return { state: newState(), changed: true, setAside: null }
    throw err
  }
  // A byte order mark in front (the file saved by an editor or by PowerShell 5.1's
  // Set-Content -Encoding utf8) is not part of the JSON: without this the state
  // would be set aside and the identity lost, with every source to pair again.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  let parsed = null
  try {
    parsed = normalizeState(JSON.parse(text))
  } catch {}
  if (parsed !== null) return { state: parsed.state, changed: parsed.changed, setAside: null }
  const aside = statePath + '.corrupt-' + Date.now()
  fs.renameSync(statePath, aside)
  return { state: newState(), changed: true, setAside: aside }
}

/**
 * Write the state atomically (temporary file, fsync, rename), mode 0600.
 * @param {string} statePath
 * @param {object} state
 * @param {object} [opts]
 * @param {number} [opts.retries=8]  rename retries on a busy target (Windows)
 */
export async function writeStateFile (statePath, state, opts) {
  return writeFileAtomic(statePath, b4a.from(JSON.stringify(state, null, 2) + '\n', 'utf8'), opts)
}

/**
 * Write bytes to a file atomically, the same way: <file>.tmp (0600), fsync, rename
 * over the file, directory fsync. A failed write leaves the file as it was.
 * @param {string} file
 * @param {Uint8Array} data
 * @param {object} [opts]
 * @param {number} [opts.retries=8]  rename retries on a busy target (Windows)
 */
export async function writeFileAtomic (file, data, { retries = 8 } = {}) {
  const tmp = file + '.tmp'
  const fd = fs.openSync(tmp, 'w', 0o600)
  try {
    let off = 0
    while (off < data.byteLength) off += fs.writeSync(fd, data, off, data.byteLength - off)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  try {
    fs.chmodSync(tmp, 0o600) // the file may have existed with other permissions
  } catch {}
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file)
      break
    } catch (err) {
      if (attempt >= retries || !(err && RETRY_CODES.has(err.code))) {
        try {
          fs.unlinkSync(tmp)
        } catch {}
        throw err
      }
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)))
    }
  }
  syncDir(path.dirname(file))
}

// The rename itself is durable only once the directory is flushed (Linux,
// Android). Opening a directory fails on Windows: nothing to do there.
function syncDir (dir) {
  let fd = -1
  try {
    fd = fs.openSync(dir, 'r')
    fs.fsyncSync(fd)
  } catch {
  } finally {
    if (fd !== -1) {
      try {
        fs.closeSync(fd)
      } catch {}
    }
  }
}

export function ensureParentDir (statePath) {
  fs.mkdirSync(path.dirname(path.resolve(statePath)), { recursive: true })
}
