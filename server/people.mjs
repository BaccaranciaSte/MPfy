// Who is asking, and what changes when people come and go: the profile and role
// of a request, the binding of a device key to a profile, the owner claim, a new
// owner, a removed profile or device.
//
// Resolution, once per request, when it arrives and before any await:
//   1. from 127.0.0.1 (local): the owner, profile headers ignored;
//   2. profile headers (either one): both valid and the profile not removed, else
//      403 bad_profile; a key bound to another profile is refused; an unbound key
//      is bound now (a profile may have any number of keys) and may claim the source;
//   3. no headers, key bound: its profile;
//   4. no headers, unbound legacy key: the owner (an older app of the owner);
//   5. otherwise a guest (a device in the password recovery flow).
// A request from anywhere else with no P2P mapping is refused (403 forbidden).

import path from 'node:path'
import fs from 'node:fs'
import { HttpError, apiError } from './errors.mjs'
import { checkProof } from './proof.mjs'
import { log, logError } from './util.mjs'

const PROOF_CACHE = 256

export class People {
  constructor (deps) {
    Object.assign(this, deps) // source, profiles, clients, users, recovery, social, chat, comments, library, sessions, pending, archives, fingerprints, transport, serverPublicKey
    this._proofs = new Map() // clientKey|profile|proof -> { profileId, signPublicKey }
  }

  get ownerProfileId () {
    return this.source.ownerProfileId
  }

  /** Whose data the owner acting without a profile reads and writes. */
  ownerActor () {
    return this.source.ownerProfileId || 'owner'
  }

  isOwnerActor (actor) {
    return actor === 'owner' || (actor !== null && actor === this.source.ownerProfileId)
  }

  /** The ids that count as `actor` in uploaders. */
  viewerForActor (actor) {
    if (actor === null || actor === undefined) return new Set()
    if (this.isOwnerActor(actor)) return new Set(['owner', this.source.ownerProfileId].filter(Boolean))
    return new Set([actor])
  }

  callerForActor (actor, { ask = false, clientKey = null } = {}) {
    const role = this.isOwnerActor(actor) ? 'owner' : 'member'
    return { actor, role, ask, clientKey, profileId: actor === 'owner' ? null : actor, key: clientKey, local: false }
  }

  // ------------------------------------------------------------- resolution

  /** The caller of a request (see the top of this file). Throws HttpError. */
  resolve (req, whoIs) {
    const remote = req.socket ? req.socket.remoteAddress : null
    if (remote === '127.0.0.1' || remote === '::ffff:127.0.0.1') {
      return { local: true, key: null, role: 'owner', profileId: null, actor: this.ownerActor(), ask: false }
    }
    const key = whoIs(req)
    if (key === null) throw apiError('forbidden')
    const client = this.clients.get(key)
    if (client === null) throw apiError('forbidden')
    const h = req.headers
    if (h['x-mpfy-profile'] !== undefined || h['x-mpfy-profile-proof'] !== undefined) {
      const proof = this._proof(key, h['x-mpfy-profile'], h['x-mpfy-profile-proof'])
      if (proof === null || this.profiles.isRemoved(proof.profileId)) throw apiError('bad_profile')
      if (client.profileId && client.profileId !== proof.profileId) throw apiError('bad_profile')
      if (!client.profileId) this._bind(key, client, proof)
      this.profiles.seen(proof.profileId)
      return this._asProfile(key, proof.profileId, true)
    }
    if (client.profileId) {
      if (this.profiles.isRemoved(client.profileId)) throw apiError('bad_profile')
      this.profiles.seen(client.profileId)
      return this._asProfile(key, client.profileId, false)
    }
    if (client.legacy === true) return { local: false, key, role: 'owner', profileId: null, actor: this.ownerActor(), ask: false, legacy: true }
    return { local: false, key, role: 'guest', profileId: null, actor: null, ask: false }
  }

  _asProfile (key, profileId, ask) {
    const role = profileId === this.source.ownerProfileId ? 'owner' : 'member'
    return { local: false, key, role, profileId, actor: profileId, ask }
  }

  _proof (key, profileHeader, proofHeader) {
    const cacheKey = key + '|' + profileHeader + '|' + proofHeader
    const hit = this._proofs.get(cacheKey)
    if (hit !== undefined) {
      this._proofs.delete(cacheKey)
      this._proofs.set(cacheKey, hit)
      return hit
    }
    const proof = checkProof(profileHeader, proofHeader, key, this.serverPublicKey)
    if (proof === null) return null
    this._proofs.set(cacheKey, proof)
    if (this._proofs.size > PROOF_CACHE) this._proofs.delete(this._proofs.keys().next().value)
    return proof
  }

  _bind (key, client, proof) {
    const { profileId, signPublicKey } = proof
    const known = this.profiles.get(profileId)
    // The record first: a key is never bound to a profile the source cannot list.
    if (known === null) this.profiles.create(profileId, signPublicKey)
    this.clients.bind(key, profileId)
    log('device ' + key.slice(0, 16) + '... bound to profile ' + profileId)
    // The claim: a legacy key (the owner's device from before profiles), or a profile new to
    // this source inside the window the CLI opened. Nothing else ever makes an
    // owner: a profile already bound here never claims later.
    if (this.source.ownerProfileId === null && (client.legacy === true || (known === null && this.source.claimOpen()))) this.claim(profileId)
  }

  // ------------------------------------------------------------------ owner

  // The claim runs while a request is resolved, which never waits: the merge of the owner's
  // data goes on by itself, and the requests of either person wait for it.
  claim (profileId) {
    this.source.update({ ownerProfileId: profileId, claimUntil: 0 })
    log('profile ' + profileId + ' claimed the source as its owner')
    this.ownerSteps().catch((err) => logError('owner data move failed: ' + err.message))
  }

  /**
   * After any change of owner, and at start: the owner's data from before the
   * claim (users/owner.log, "owner" in uploaders and in unfinished uploads)
   * becomes the owner's profile's; a set-owner --move-data not finished yet is
   * finished. The people's data merge in the background (users.merge holds both
   * people meanwhile); the move is marked done once its merge is, so one cut by a
   * stop runs again at the next start. Resolves when the merges are over.
   */
  ownerSteps () {
    const owner = this.source.ownerProfileId
    if (owner === null) return Promise.resolve()
    const merges = []
    if (this.users.has('owner')) merges.push(this.users.merge('owner', owner))
    this._replaceActor('owner', owner)
    const move = this.source.move
    if (move !== null) {
      let moved = Promise.resolve(true)
      if (move.from !== move.to) {
        moved = this.users.merge(move.from, move.to)
        this._replaceActor(move.from, move.to)
      }
      this.library.flushNow()
      merges.push(moved.then((done) => {
        const now = this.source.move
        if (done && now !== null && now.from === move.from && now.to === move.to) this.source.update({ move: null })
      }))
    }
    return Promise.all(merges).then(() => {})
  }

  _replaceActor (from, to) {
    this.library.replaceUploader(from, to)
    this.sessions.replaceProfile(from, to)
    this.pending.replaceProfile(from, to)
    this.archives.replaceProfile(from, to)
  }

  /**
   * set-owner: an existing, not removed profile becomes the owner. Resolves when
   * the data moved with it is merged.
   */
  setOwner (profileId, moveData) {
    const p = this.profiles.get(profileId)
    if (p === null || p.removedAt !== null) throw new HttpError(404, 'Profilo non trovato')
    const previous = this.source.ownerProfileId || 'owner'
    const move = moveData && previous !== profileId ? { from: previous, to: profileId } : null
    this.source.update({ ownerProfileId: profileId, claimUntil: 0, move })
    log('owner set to profile ' + profileId + (move ? ' (data moved from ' + previous + ')' : ''))
    return this.ownerSteps()
  }

  /** Open the claim window (CLI on the source). Returns { ownerProfileId, claimUntil }. */
  openClaim (minutes) {
    if (this.source.ownerProfileId !== null) return { ownerProfileId: this.source.ownerProfileId, claimUntil: 0 }
    const claimUntil = Date.now() + minutes * 60000
    this.source.update({ claimUntil })
    log('claim window open for ' + minutes + ' minute(s)')
    return { ownerProfileId: null, claimUntil }
  }

  // ---------------------------------------------------------------- removal

  /** A device goes: its admission, its binding, its recovery blob, its connections. */
  removeClient (key, { graceMs = 0 } = {}) {
    const client = this.clients.get(key)
    if (client === null) return false
    this.clients.remove(key)
    if (client.profileId) this.recovery.deleteDevice(client.profileId, key)
    for (const k of [...this._proofs.keys()]) if (k.startsWith(key + '|')) this._proofs.delete(k)
    const transport = this.transport()
    if (transport) transport.dropClient(key, graceMs > 0 ? { graceMs } : {})
    return true
  }

  /** A profile leaves the source (the owner's own cannot). */
  removeProfile (profileId) {
    if (profileId === this.source.ownerProfileId) throw apiError('forbidden')
    const p = this.profiles.get(profileId)
    if (p === null || p.removedAt !== null) throw new HttpError(404, 'Profilo non trovato')
    this.profiles.markRemoved(profileId)
    this._cleanRemoved(profileId)
    log('profile ' + profileId + ' removed')
  }

  _cleanRemoved (profileId) {
    // Its card, settings and plays go at once: nobody sees a removed profile.
    if (this.social) this.social.remove(profileId)
    // Its direct conversations go with their files; in the group its read marks and
    // its silent entry go, its messages stay. At every start too: a file left from
    // before goes then.
    if (this.chat) this.chat.removeProfile(profileId)
    // Its comments go (never served again; out of the files in the background).
    if (this.comments) this.comments.removeProfile(profileId).catch((err) => logError('comments of ' + profileId + ' not removed: ' + err.message))
    for (const key of this.clients.boundTo(profileId)) this.removeClient(key)
    this.recovery.removeProfile(profileId)
    this.sessions.dropProfile(profileId)
    this.pending.dropProfile(profileId)
    this.archives.dropProfile(profileId)
    // A data move from this profile not finished yet (it failed at start) still
    // needs its file and its tracks: they go once it is done.
    const move = this.source.move
    if (move !== null && move.from === profileId) return
    this.users.remove(profileId)
    this.library.dropUploaderEverywhere(profileId)
  }

  /**
   * At start: the owner steps (their merges waited for, before anything is
   * served), removals made by the CLI while the server was stopped, and recovery
   * blobs of devices that are no longer bound.
   */
  async startup () {
    try {
      await this.ownerSteps()
    } catch (err) {
      logError('owner data move failed: ' + err.message)
    }
    for (const p of this.profiles.removed()) {
      if (p.profileId !== this.source.ownerProfileId) this._cleanRemoved(p.profileId)
    }
    for (const e of this.recovery.entries()) {
      const c = this.clients.get(e.device)
      if (c === null || c.profileId !== e.profileId) this.recovery.deleteDevice(e.profileId, e.device)
    }
  }
}

/**
 * source.json missing: write it, and when the data dir holds a source from
 * before profiles, keep every device admitted then as the owner's (legacy).
 * The server at start and the CLI share this, so neither skips the migration.
 */
export function ensureSourceFile (dataDir, source, clients, name) {
  if (source.exists()) return false
  const migrated = isOldDataDir(dataDir, clients)
  if (migrated) clients.markAllLegacy()
  source.ensure({ name, migratedAt: migrated ? Date.now() : null })
  if (migrated) log('data from before profiles: ' + clients.list().length + " device(s) kept as the owner's")
  return migrated
}

/** Does the data dir hold a source from before profiles? */
export function isOldDataDir (dataDir, clients) {
  let schema = null
  try {
    const db = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'))
    schema = Number.isInteger(db.schema) ? db.schema : 1
  } catch (err) {
    schema = err.code === 'ENOENT' ? null : 'unreadable'
  }
  if (typeof schema === 'number') return schema < 3
  return clients.list().length > 0
}
