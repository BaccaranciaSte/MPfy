// source.json: the source's own name, its owner, the claim window, and the
// owner's switch of the details from the network with its AcoustID key.
//   { schema, name, named, ownerProfileId, claimUntil, migratedAt, details, acoustidKey, card }
// card: the memory card the owner chose for the music (places.mjs), absent when none.
// details: absent is true; acoustidKey: null is the source's own key.
// Re-read when its modification time or size changes, so the CLI can edit it
// while the server runs. Unknown fields are kept. A `move` field ({ from, to })
// marks a set-owner --move-data that has not finished yet.

import fs from 'node:fs'
import path from 'node:path'
import { isProfileId } from './ids.mjs'
import { validCard } from './places.mjs'
import { ACOUSTID_KEY_RE } from './details.mjs'
import { writeJsonAtomicSync, logError } from './util.mjs'

export class SourceStore {
  constructor (dataDir) {
    this.file = path.join(dataDir, 'source.json')
    this._data = null
    this._stamp = null
  }

  _statStamp () {
    try {
      const st = fs.statSync(this.file)
      return st.mtimeMs + ':' + st.size
    } catch {
      return 'missing'
    }
  }

  /** Does source.json exist on disk? */
  exists () {
    return fs.existsSync(this.file)
  }

  _reload () {
    const stamp = this._statStamp()
    if (stamp === this._stamp && this._data !== null) return
    this._stamp = stamp
    if (stamp === 'missing') return
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object')
      this._data = normalize(raw, this._data ? this._data.name : 'MPfy')
    } catch (err) {
      // Keep what we had: a half edited file must not hand the source to anyone.
      logError('source.json unreadable (' + err.message + '), keeping the last known values')
    }
  }

  /** Create source.json when missing. */
  ensure ({ name, migratedAt = null }) {
    this._reload()
    if (this._data !== null && this.exists()) return false
    this._data = normalize({ schema: 1, name, named: false, ownerProfileId: null, claimUntil: 0, migratedAt }, name)
    this._write()
    return true
  }

  get data () {
    this._reload()
    return this._data
  }

  get name () {
    return this.data.name
  }

  get named () {
    return this.data.named
  }

  get ownerProfileId () {
    return this.data.ownerProfileId
  }

  get claimUntil () {
    return this.data.claimUntil
  }

  get migratedAt () {
    return this.data.migratedAt
  }

  get move () {
    return this.data.move || null
  }

  get details () {
    return this.data.details
  }

  get acoustidKey () {
    return this.data.acoustidKey
  }

  /** Is the claim window open now (and nobody owns the source)? */
  claimOpen (now = Date.now()) {
    const d = this.data
    return d.ownerProfileId === null && d.claimUntil > now
  }

  update (patch) {
    this._reload()
    this._data = { ...this._data, ...patch }
    if (this._data.move === null) delete this._data.move
    this._write()
  }

  _write () {
    writeJsonAtomicSync(this.file, this._data)
    this._stamp = this._statStamp()
  }
}

function normalize (raw, fallbackName) {
  const out = { ...raw }
  out.schema = 1
  out.name = typeof raw.name === 'string' && raw.name.trim() ? raw.name : String(fallbackName || 'MPfy')
  out.named = raw.named === true
  out.ownerProfileId = isProfileId(raw.ownerProfileId) ? raw.ownerProfileId : null
  out.claimUntil = Number.isFinite(raw.claimUntil) && raw.claimUntil > 0 ? raw.claimUntil : 0
  out.migratedAt = Number.isFinite(raw.migratedAt) ? raw.migratedAt : null
  out.details = raw.details !== false
  out.acoustidKey = typeof raw.acoustidKey === 'string' && ACOUSTID_KEY_RE.test(raw.acoustidKey) ? raw.acoustidKey : null
  // The memory card: kept when well formed; a malformed one is never turned into
  // "no card" (the next start would drop every track on it): it stays, marked
  // invalid, until the owner uses or forgets a card.
  if (raw.card === undefined || raw.card === null) {
    delete out.card
  } else if (!validCard(raw.card)) {
    out.card = { ...(raw.card && typeof raw.card === 'object' && !Array.isArray(raw.card) ? raw.card : { value: raw.card }), invalid: true }
  }
  if (raw.move && typeof raw.move === 'object' && (raw.move.from === 'owner' || isProfileId(raw.move.from)) && isProfileId(raw.move.to)) {
    out.move = { from: raw.move.from, to: raw.move.to }
  } else {
    delete out.move
  }
  return out
}
