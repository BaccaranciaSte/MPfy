// profiles.json: the people this source knows.
//   { schema: 1, profiles: [{ profileId, signPublicKey, name, nameUpdatedAt,
//     photo, photoUpdatedAt, createdAt, lastSeenAt, removedAt }] }
// A record is made at the first binding of a profileId with an empty name (the
// client core then sends its name). Unknown fields are kept. Re-read when the
// file changes on disk (the CLI marks removals while the server is stopped).
// photo: null or the SHA-256 (64 hex) of the profile's JPEG, whose bytes are
// profile-photos/<profileId>-<hash>.jpg; photoUpdatedAt: its time (0: never set; a
// removal has a time too). The newer time wins, and at the very same time the
// greater hash (none below any photo), the rule of the client core too. Records
// written before photos read as null and 0. A record never points to a missing
// file: the new file is written first (a file already there under its name holds
// the same bytes and stays as it is), then the record, then the old file goes.
// Files no record points to are removed when the store loads.
// A file that does not parse is never written over: it holds who was removed,
// and a fresh list would let a removed profile bind again. Until it is fixed by
// hand, nothing about profiles changes (the last known list is still read).

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { isProfileId, isPublicKey } from './ids.mjs'
import { writeJsonAtomicSync, writeAtomicSync, ensureDir, unlinkQuiet, removeAside, logError } from './util.mjs'

const SEEN_EVERY_MS = 60 * 1000
// A name or photo time further in the future than this is refused (clock skew allowed).
const NAME_FUTURE_MS = 5 * 60 * 1000
export const MAX_PHOTO_BYTES = 48 * 1024
const HASH_RE = /^[0-9a-f]{64}$/

/** A profile photo as the sources take it: 1 to 48 KB, FF D8 FF in front, FF D9 at the end. */
export function validPhoto (bytes) {
  if (!(bytes instanceof Uint8Array)) return false
  const n = bytes.length
  return n >= 1 && n <= MAX_PHOTO_BYTES &&
    bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes[n - 2] === 0xff && bytes[n - 1] === 0xd9
}

/** The SHA-256 of a photo, 64 lower-case hex: its name. */
export function photoHash (bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

/**
 * Whether the photo `hash` (null: none) set at `at` wins over `thanHash` set at
 * `than`: the newer time, and at the very same time the greater hash, none below
 * any photo. Every device of a profile and every source keeps the same rule, so
 * changes made in the same millisecond still end on one photo everywhere.
 */
export function photoWins (at, hash, than, thanHash) {
  return at > than || (at === than && (hash || '') > (thanHash || ''))
}

// A file under that name (not a folder, not one on its way out).
function isFile (file) {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

export class ProfilesStore {
  constructor (dataDir) {
    this.file = path.join(dataDir, 'profiles.json')
    this.photoDir = path.resolve(dataDir, 'profile-photos')
    this._list = []
    this._byId = new Map()
    this._extra = {}
    this._stamp = null
    this._unreadable = false
    this._reload()
    this._sweepPhotos()
  }

  // Photo files no record points to: an old photo whose removal was cut short (or
  // moved aside while a device was reading it), a temporary file, the photo of a
  // removed profile. Best effort, never throws;
  // not while profiles.json is unreadable (who has which photo is unknown then).
  _sweepPhotos () {
    if (this._unreadable) return
    let names
    try {
      names = fs.readdirSync(this.photoDir)
    } catch {
      return
    }
    const keep = new Set()
    for (const p of this._list) if (p.photo !== null && p.removedAt === null) keep.add(p.profileId + '-' + p.photo + '.jpg')
    for (const name of names) if (!keep.has(name)) unlinkQuiet(path.join(this.photoDir, name))
  }

  _photoPath (profileId, hash) {
    return path.join(this.photoDir, profileId + '-' + hash + '.jpg')
  }

  _statStamp () {
    try {
      const st = fs.statSync(this.file)
      return st.mtimeMs + ':' + st.size
    } catch {
      return 'missing'
    }
  }

  _reload () {
    const stamp = this._statStamp()
    if (stamp === this._stamp) return
    this._stamp = stamp
    if (stamp === 'missing') {
      this._unreadable = false
      this._set([])
      return
    }
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (!raw || !Array.isArray(raw.profiles)) throw new Error('no profiles array')
      const { profiles, schema, ...extra } = raw
      this._extra = extra
      this._set(profiles)
      this._unreadable = false
    } catch (err) {
      this._unreadable = true
      logError('profiles.json unreadable (' + err.message + '), keeping ' + this._list.length + ' known profile(s)')
    }
  }

  _set (items) {
    const list = []
    const byId = new Map()
    for (const p of items) {
      if (!p || !isProfileId(p.profileId) || byId.has(p.profileId)) continue
      const rec = {
        ...p,
        signPublicKey: isPublicKey(p.signPublicKey) ? p.signPublicKey : null,
        name: typeof p.name === 'string' ? p.name : '',
        nameUpdatedAt: Number.isFinite(p.nameUpdatedAt) ? p.nameUpdatedAt : 0,
        photo: typeof p.photo === 'string' && HASH_RE.test(p.photo) ? p.photo : null,
        photoUpdatedAt: Number.isFinite(p.photoUpdatedAt) ? p.photoUpdatedAt : 0,
        createdAt: Number.isFinite(p.createdAt) ? p.createdAt : 0,
        lastSeenAt: Number.isFinite(p.lastSeenAt) ? p.lastSeenAt : 0,
        removedAt: Number.isFinite(p.removedAt) ? p.removedAt : null
      }
      list.push(rec)
      byId.set(rec.profileId, rec)
    }
    this._list = list
    this._byId = byId
  }

  _write (list = this._list) {
    if (this._unreadable) throw new Error("profiles.json non leggibile: va corretto a mano prima di cambiare i profili")
    writeJsonAtomicSync(this.file, { ...this._extra, schema: 1, profiles: list })
    this._stamp = this._statStamp()
  }

  get (profileId) {
    this._reload()
    return this._byId.get(profileId) || null
  }

  /** get() for an answer about many profiles: profiles.json looked at once, not once each. */
  lookup () {
    this._reload()
    const byId = this._byId
    return (profileId) => byId.get(profileId) || null
  }

  isRemoved (profileId) {
    const p = this.get(profileId)
    return p !== null && p.removedAt !== null
  }

  /** Profiles not removed. */
  active () {
    this._reload()
    return this._list.filter((p) => p.removedAt === null)
  }

  removed () {
    this._reload()
    return this._list.filter((p) => p.removedAt !== null)
  }

  create (profileId, signPublicKey, now = Date.now()) {
    this._reload()
    const rec = { profileId, signPublicKey, name: '', nameUpdatedAt: 0, photo: null, photoUpdatedAt: 0, createdAt: now, lastSeenAt: now, removedAt: null }
    this._write([...this._list, rec])
    this._list.push(rec)
    this._byId.set(profileId, rec)
    return rec
  }

  /** A request of this profile: lastSeenAt, written at most once a minute. */
  seen (profileId, now = Date.now()) {
    const p = this.get(profileId)
    if (p === null || now - p.lastSeenAt < SEEN_EVERY_MS) return
    p.lastSeenAt = now
    try {
      this._write()
    } catch (err) {
      logError('profiles.json write failed: ' + err.message)
    }
  }

  /**
   * Store a name when its time is newer than the stored one and not too far in
   * the future. Returns true when stored.
   */
  setName (profileId, name, nameUpdatedAt, now = Date.now()) {
    const p = this.get(profileId)
    if (p === null) return false
    if (!(nameUpdatedAt > p.nameUpdatedAt) || nameUpdatedAt > now + NAME_FUTURE_MS) return false
    p.name = name
    p.nameUpdatedAt = nameUpdatedAt
    this._write()
    return true
  }

  /**
   * Store a photo (its bytes, or null for none) when it wins over the stored one
   * (photoWins: a newer time, or the same time and a greater hash) and its time is
   * not too far in the future, as for names. The profile must be known and not
   * removed. Returns true when stored.
   */
  setPhoto (profileId, bytes, photoUpdatedAt, now = Date.now()) {
    const p = this.get(profileId)
    if (p === null || p.removedAt !== null) return false
    if (bytes !== null && !validPhoto(bytes)) throw new TypeError('not a valid photo')
    const hash = bytes === null ? null : photoHash(bytes)
    if (!photoWins(photoUpdatedAt, hash, p.photoUpdatedAt, p.photo) || photoUpdatedAt > now + NAME_FUTURE_MS) return false
    const previous = p.photo
    const previousAt = p.photoUpdatedAt
    // The file first: the record never points to one that is not there. Named by
    // its bytes, a file already there holds these very bytes and is left alone,
    // also while a device is still downloading it (on Windows a file being read
    // cannot be written over).
    const file = hash !== null ? this._photoPath(profileId, hash) : null
    if (file !== null && !isFile(file)) {
      ensureDir(this.photoDir)
      try {
        writeAtomicSync(file, bytes)
      } catch (err) {
        unlinkQuiet(file + '.tmp')
        throw err
      }
    }
    p.photo = hash
    p.photoUpdatedAt = photoUpdatedAt
    try {
      this._write()
    } catch (err) {
      p.photo = previous
      p.photoUpdatedAt = previousAt
      if (hash !== null && hash !== previous) unlinkQuiet(this._photoPath(profileId, hash))
      throw err
    }
    // The old file only once no record points to it, moved out of the way first:
    // on Windows a file a device still reads would keep its name until the reader
    // lets go, and that photo may come back meanwhile. A copy that cannot be
    // removed yet is swept at the next load.
    if (previous !== null && previous !== hash) removeAside(this._photoPath(profileId, previous), this.photoDir)
    return true
  }

  /** The file of a profile's photo (absolute path), or null when it has none. */
  photoFile (profileId) {
    const p = this.get(profileId)
    if (p === null || p.removedAt !== null || p.photo === null) return null
    return this._photoPath(profileId, p.photo)
  }

  /** A profile leaves: marked removed, and its photo goes with it (record first, then the file). */
  markRemoved (profileId, now = Date.now()) {
    const p = this.get(profileId)
    if (p === null || p.removedAt !== null) return false
    const photo = p.photo
    p.removedAt = now
    p.photo = null
    this._write()
    if (photo !== null) unlinkQuiet(this._photoPath(profileId, photo))
    return true
  }
}
