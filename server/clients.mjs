// clients.json: the public keys admitted through the HyperDHT firewall.
// [{ publicKey, name, addedAt, legacy?, profileId? }], written atomically (0600).
// `legacy`: admitted before profiles existed (an older app of the owner).
// `profileId`: the profile this key is bound to (set at its first valid proof).
// Other fields are kept as they are. The file is re-read
// when its modification time or size changes, so an edit by hand takes effect on
// the next connection attempt without a restart.
//
// A file that does not parse (a hand edit with a stray comma) is never written
// over: before the next add() or remove() it is set aside as
// clients.json.corrupt-<ms>, like db.json, so the keys it held can be recovered.

import fs from 'node:fs'
import path from 'node:path'
import { isPublicKey, isProfileId } from './ids.mjs'
import { writeAtomicSync, renameSyncRetry, logError } from './util.mjs'

export class ClientsStore {
  constructor (dataDir) {
    this.file = path.join(dataDir, 'clients.json')
    this._list = []
    this._keys = new Set()
    this._stamp = null
    this._unreadable = false // the file on disk (at _stamp) did not parse
    this._reload()
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
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (!Array.isArray(data)) throw new Error('not an array')
      this._set(data)
      this._unreadable = false
    } catch (err) {
      // Keep the last good list: a half-edited file must not lock everyone out
      // (nor let anyone in). It is not written over either, see _write().
      this._unreadable = true
      logError('clients.json unreadable (' + err.message + '), keeping ' + this._list.length + ' known client(s)')
    }
  }

  _set (data) {
    const list = []
    const keys = new Set()
    for (const c of data) {
      const key = c && typeof c.publicKey === 'string' ? c.publicKey.toLowerCase() : null
      if (!isPublicKey(key) || keys.has(key)) continue
      keys.add(key)
      const entry = { ...c, publicKey: key, name: typeof c.name === 'string' ? c.name : '', addedAt: Number(c.addedAt) || 0 }
      if (entry.legacy !== true) delete entry.legacy
      if (!isProfileId(entry.profileId)) delete entry.profileId
      list.push(entry)
    }
    this._list = list
    this._keys = keys
  }

  _write () {
    if (this._unreadable) {
      // The file holds keys we could not read (at startup: none known at all).
      // Writing our list over it would lose them for good: move it aside first.
      // If that fails, the write does not happen (the caller sees the error).
      const aside = this.file + '.corrupt-' + Date.now()
      try {
        renameSyncRetry(this.file, aside)
        logError('clients.json was unreadable, moved to ' + path.basename(aside) + ' before writing a new one')
      } catch (err) {
        if (err.code !== 'ENOENT') throw err // gone meanwhile: nothing left to keep
      }
      this._unreadable = false
    }
    writeAtomicSync(this.file, JSON.stringify(this._list, null, 2) + '\n')
    this._stamp = this._statStamp()
  }

  has (publicKeyHex) {
    this._reload()
    return this._keys.has(String(publicKeyHex).toLowerCase())
  }

  list () {
    this._reload()
    return this._list.map((c) => ({ ...c }))
  }

  get (publicKeyHex) {
    this._reload()
    const key = String(publicKeyHex).toLowerCase()
    const c = this._list.find((x) => x.publicKey === key)
    return c ? { ...c } : null
  }

  /** Keys bound to a profile. */
  boundTo (profileId) {
    this._reload()
    return this._list.filter((c) => c.profileId === profileId).map((c) => c.publicKey)
  }

  /** Bind an admitted key to a profile (one profile per key). */
  bind (publicKeyHex, profileId) {
    this._reload()
    const key = String(publicKeyHex).toLowerCase()
    const c = this._list.find((x) => x.publicKey === key)
    if (!c) return false
    c.profileId = profileId
    this._write()
    return true
  }

  /** Mark every admitted key as admitted before profiles (the migration). */
  markAllLegacy () {
    this._reload()
    let changed = false
    for (const c of this._list) {
      if (c.legacy !== true) {
        c.legacy = true
        changed = true
      }
    }
    if (changed) this._write()
    return changed
  }

  add (publicKeyHex, name) {
    this._reload()
    const key = String(publicKeyHex).toLowerCase()
    if (!isPublicKey(key)) throw new Error('invalid public key')
    const clean = String(name || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 100)
    const existing = this._list.find((c) => c.publicKey === key)
    if (existing) {
      if (clean) existing.name = clean
    } else {
      this._list.push({ publicKey: key, name: clean, addedAt: Date.now() })
      this._keys.add(key)
    }
    this._write()
  }

  remove (publicKeyHex) {
    this._reload()
    const key = String(publicKeyHex).toLowerCase()
    if (!this._keys.has(key)) return false
    this._list = this._list.filter((c) => c.publicKey !== key)
    this._keys.delete(key)
    this._write()
    return true
  }
}
