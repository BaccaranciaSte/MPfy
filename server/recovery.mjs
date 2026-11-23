// recovery/<profileId>.json: password recovery blobs, one per device of a
// profile, and the profile's failure counter and lock.
//   { failures: [ms], lockedUntil, locks, devices: { <clientPublicKey>:
//     { deviceName, salt, opslimit, memlimit, verifierHash, blob, updatedAt } } }
// The source never sees the password: it keeps opaque values and hands a blob out
// only to whoever proves the verifier. 5 wrong tries within an hour lock the
// profile for 1 h x 2^locks (at most 30 days); a release or a PUT resets `locks`.

import fs from 'node:fs'
import path from 'node:path'
import { isProfileId, isPublicKey } from './ids.mjs'
import { verifierHashOf, sameBytes } from './proof.mjs'
import { ensureDir, writeJsonAtomicSync, readJsonFile, unlinkQuiet } from './util.mjs'

export const OPSLIMIT = 3
export const MEMLIMIT = 67108864
export const MAX_BLOB_BYTES = 65536
const MAX_FAILURES = 5
const HOUR = 60 * 60 * 1000
const MAX_LOCK_MS = 30 * 24 * HOUR
const FILE_RE = /^([0-9a-f]{32})\.json$/
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

export class RecoveryStore {
  constructor (dataDir) {
    this.dir = path.join(dataDir, 'recovery')
    ensureDir(this.dir)
    this._records = new Map() // profileId -> record
    for (const name of fs.readdirSync(this.dir)) {
      const m = FILE_RE.exec(name)
      if (m === null) continue
      const rec = normalize(readJsonFile(path.join(this.dir, name)))
      if (rec !== null) this._records.set(m[1], rec)
    }
  }

  _file (profileId) {
    if (!isProfileId(profileId)) throw new Error('invalid profile id')
    return path.join(this.dir, profileId + '.json')
  }

  _save (profileId, rec) {
    if (Object.keys(rec.devices).length === 0 && rec.failures.length === 0 && rec.lockedUntil <= Date.now()) {
      this._records.delete(profileId)
      unlinkQuiet(this._file(profileId))
      return
    }
    this._records.set(profileId, rec)
    writeJsonAtomicSync(this._file(profileId), rec)
  }

  _record (profileId) {
    return this._records.get(profileId) || { failures: [], lockedUntil: 0, locks: 0, devices: {} }
  }

  /** This device's blob: { updatedAt } or null. */
  deviceInfo (profileId, deviceKey) {
    const rec = this._records.get(profileId)
    const d = rec && rec.devices[deviceKey]
    return d ? { updatedAt: d.updatedAt } : null
  }

  hasAny (profileId) {
    const rec = this._records.get(profileId)
    return !!rec && Object.keys(rec.devices).length > 0
  }

  /**
   * Store a device's blob when newer than the stored one. Resets the profile's
   * failures, lock and locks. Returns the stored updatedAt.
   */
  put (profileId, deviceKey, body, deviceName) {
    const rec = this._record(profileId)
    const existing = rec.devices[deviceKey]
    if (!existing || body.updatedAt > existing.updatedAt) {
      rec.devices[deviceKey] = {
        deviceName: String(deviceName || ''),
        salt: body.salt,
        opslimit: body.opslimit,
        memlimit: body.memlimit,
        verifierHash: body.verifierHash,
        blob: body.blob,
        updatedAt: body.updatedAt
      }
    }
    rec.failures = []
    rec.lockedUntil = 0
    rec.locks = 0
    this._save(profileId, rec)
    return rec.devices[deviceKey].updatedAt
  }

  deleteDevice (profileId, deviceKey) {
    const rec = this._records.get(profileId)
    if (!rec || !rec.devices[deviceKey]) return false
    delete rec.devices[deviceKey]
    this._save(profileId, rec)
    return true
  }

  removeProfile (profileId) {
    this._records.delete(profileId)
    unlinkQuiet(this._file(profileId))
  }

  /** Every device blob: [{ profileId, device, deviceName, updatedAt }]. */
  entries () {
    const out = []
    for (const [profileId, rec] of this._records) {
      for (const [device, d] of Object.entries(rec.devices)) out.push({ profileId, device, deviceName: d.deviceName, updatedAt: d.updatedAt })
    }
    return out
  }

  params (profileId, deviceKey) {
    const rec = this._records.get(profileId)
    const d = rec && rec.devices[deviceKey]
    return d ? { salt: d.salt, opslimit: d.opslimit, memlimit: d.memlimit } : null
  }

  /**
   * Try a verifier (32 bytes). Returns one of
   *   { missing: true } | { locked: true, retryAt } | { ok: true, blob, updatedAt }
   *   | { wrong: true, triesLeft } | { locked: true, retryAt, justLocked: true }
   */
  release (profileId, deviceKey, verifier, now = Date.now()) {
    const rec = this._records.get(profileId)
    const d = rec && rec.devices[deviceKey]
    if (!d) return { missing: true }
    if (rec.lockedUntil > now) return { locked: true, retryAt: rec.lockedUntil }
    rec.failures = rec.failures.filter((t) => now - t < HOUR)
    if (sameBytes(verifierHashOf(verifier), Buffer.from(d.verifierHash, 'hex'))) {
      rec.locks = 0
      this._save(profileId, rec)
      return { ok: true, blob: d.blob, updatedAt: d.updatedAt }
    }
    rec.failures.push(now)
    if (rec.failures.length >= MAX_FAILURES) {
      rec.lockedUntil = now + Math.min(HOUR * 2 ** rec.locks, MAX_LOCK_MS)
      rec.locks++
      this._save(profileId, rec)
      return { locked: true, retryAt: rec.lockedUntil }
    }
    this._save(profileId, rec)
    return { wrong: true, triesLeft: MAX_FAILURES - rec.failures.length }
  }
}

/** The body of PUT /api/recovery, validated; null when anything is off. */
export function validRecoveryBody (b) {
  if (!b || typeof b !== 'object') return null
  if (typeof b.salt !== 'string' || !/^[0-9a-f]{32}$/.test(b.salt)) return null
  if (b.opslimit !== OPSLIMIT || b.memlimit !== MEMLIMIT) return null
  if (typeof b.verifierHash !== 'string' || !/^[0-9a-f]{64}$/.test(b.verifierHash)) return null
  if (typeof b.updatedAt !== 'number' || !Number.isFinite(b.updatedAt)) return null
  if (typeof b.blob !== 'string' || b.blob.length === 0 || !BASE64_RE.test(b.blob)) return null
  const bytes = Buffer.from(b.blob, 'base64')
  if (bytes.length === 0 || bytes.length > MAX_BLOB_BYTES || bytes[0] !== 0x01) return null
  return { salt: b.salt, opslimit: b.opslimit, memlimit: b.memlimit, verifierHash: b.verifierHash, blob: b.blob, updatedAt: b.updatedAt }
}

function normalize (raw) {
  if (!raw || typeof raw !== 'object') return null
  const devices = {}
  if (raw.devices && typeof raw.devices === 'object') {
    for (const [key, d] of Object.entries(raw.devices)) {
      if (!isPublicKey(key) || !d || typeof d !== 'object') continue
      devices[key] = d
    }
  }
  return {
    ...raw,
    failures: Array.isArray(raw.failures) ? raw.failures.filter(Number.isFinite) : [],
    lockedUntil: Number.isFinite(raw.lockedUntil) ? raw.lockedUntil : 0,
    locks: Number.isInteger(raw.locks) && raw.locks > 0 ? raw.locks : 0,
    devices
  }
}
