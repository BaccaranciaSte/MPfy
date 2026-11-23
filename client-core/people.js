// The people of the client core: the profile card this profile publishes on every
// social source, the checks of every card it reads (so a source can neither rename
// a person nor swap their chat key), the conversation ids, and the union of what
// the sources say of their people.
//
//   card   = { v: 1, profileId, signPublicKey, chatPublicKey, name, photo, updatedAt, sig }
//   sig    = Ed25519 of "mpfy/card/1" || UTF-8 of the JSON of
//            [1, profileId, chatPublicKey, name, photo, updatedAt]
//   direct = hex(first 16 bytes of BLAKE2b-256("mpfy/chat-direct/1" || raw(lo) || raw(hi))),
//            lo and hi the two profileIds in string order
//   group  = hex(first 16 bytes of BLAKE2b-256("mpfy/chat-group/1" || serverPublicKey))
//
// Portable: sodium-native, b4a.

import sodium from 'sodium-native'
import b4a from 'b4a'
import { blake2b256, profileIdOf, profileIdText, cleanProfileName } from './identity.js'

const TAG_CARD = b4a.from('mpfy/card/1')
const TAG_DIRECT = b4a.from('mpfy/chat-direct/1')
const TAG_GROUP = b4a.from('mpfy/chat-group/1')
const CARD_KEYS = ['v', 'profileId', 'signPublicKey', 'chatPublicKey', 'name', 'photo', 'updatedAt', 'sig']
const HEX24_RE = /^[0-9a-f]{24}$/
const HEX32_RE = /^[0-9a-f]{32}$/
const HEX64_RE = /^[0-9a-f]{64}$/
const SIG_RE = /^[0-9a-f]{128}$/
// A card's time may be this far ahead of the clock that checks it.
const AHEAD_MS = 5 * 60 * 1000
// "Now" on a source is a report of the last 120 s; an answer kept here while its
// source cannot be asked again (down) stops saying "now" a little after that.
export const NOW_KEPT_MS = 150 * 1000
export const MAX_PAGE_RECENT = 20
export const PHOTO_CACHE = 64
// Cards whose signature verified, remembered with all they cover.
const VERIFIED = new Set()
const VERIFIED_KEPT = 4096

const hex = (bytes) => b4a.toString(bytes, 'hex')

function plainObject (v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

// ------------------------------------------------------------------- cards

/** The bytes a card's signature covers. */
export function cardBytes (card) {
  const list = [1, card.profileId, card.chatPublicKey, card.name, card.photo, card.updatedAt]
  return b4a.concat([TAG_CARD, b4a.from(JSON.stringify(list), 'utf8')])
}

/**
 * The card of a profile (`keys` from profileKeys): its name, its photo's hash or
 * null, and the time of the newer of the two.
 */
export function makeCard (keys, name, photo, updatedAt) {
  const card = {
    v: 1,
    profileId: keys.id,
    signPublicKey: hex(keys.signPublicKey),
    chatPublicKey: hex(keys.chatPublicKey),
    name,
    photo,
    updatedAt,
    sig: ''
  }
  const sig = b4a.alloc(sodium.crypto_sign_BYTES)
  sodium.crypto_sign_detached(sig, cardBytes(card), keys.signSecretKey)
  card.sig = hex(sig)
  return card
}

/**
 * Whether a card is valid: exactly its eight keys, version 1, the profileId of its
 * signing key, both keys 64 hex, a name of 1 to 40 characters as it is cleaned, a
 * photo hash or null, a time in whole milliseconds above 0 and at most 5 minutes
 * ahead of `now`, and a signature that verifies.
 */
export function checkCard (card, now = Date.now()) {
  if (!plainObject(card)) return false
  const keys = Object.keys(card)
  if (keys.length !== CARD_KEYS.length || !CARD_KEYS.every((k) => keys.includes(k))) return false
  if (card.v !== 1 || typeof card.signPublicKey !== 'string' || !HEX64_RE.test(card.signPublicKey)) return false
  if (typeof card.chatPublicKey !== 'string' || !HEX64_RE.test(card.chatPublicKey)) return false
  if (typeof card.profileId !== 'string' || card.profileId !== profileIdOf(b4a.from(card.signPublicKey, 'hex'))) return false
  if (typeof card.name !== 'string' || cleanProfileName(card.name) !== card.name) return false
  if (card.photo !== null && (typeof card.photo !== 'string' || !HEX64_RE.test(card.photo))) return false
  if (!Number.isSafeInteger(card.updatedAt) || card.updatedAt <= 0 || card.updatedAt > now + AHEAD_MS) return false
  if (typeof card.sig !== 'string' || !SIG_RE.test(card.sig)) return false
  // The same card comes back every 30 s from every source: a signature checked
  // once is remembered with everything it covers (never by the signature alone).
  const key = JSON.stringify([card.signPublicKey, card.chatPublicKey, card.name, card.photo, card.updatedAt, card.sig])
  if (VERIFIED.has(key)) return true
  let ok = false
  try {
    ok = sodium.crypto_sign_verify_detached(b4a.from(card.sig, 'hex'), cardBytes(card), b4a.from(card.signPublicKey, 'hex'))
  } catch {
    ok = false
  }
  if (ok) {
    if (VERIFIED.size >= VERIFIED_KEPT) VERIFIED.clear()
    VERIFIED.add(key)
  }
  return ok
}

/** Whether card `a` wins over `b` (null: none): the newer time, at the same time the greater signature. */
export function cardWins (a, b) {
  return b === null || a.updatedAt > b.updatedAt || (a.updatedAt === b.updatedAt && a.sig > b.sig)
}

// --------------------------------------------------------------------- ids

/** The direct conversation of two profiles (32 hex each), the same from both sides. */
export function directId (a, b) {
  const [lo, hi] = a < b ? [a, b] : [b, a]
  return hex(blake2b256(TAG_DIRECT, b4a.from(lo, 'hex'), b4a.from(hi, 'hex')).subarray(0, 16))
}

/** The group of a source, from its main public key (64 hex). */
export function groupId (serverPublicKey) {
  return hex(blake2b256(TAG_GROUP, b4a.from(serverPublicKey, 'hex')).subarray(0, 16))
}

// ------------------------------------------------------------------- names

// Without accents, lower case: the same name typed in different ways.
export function foldName (s) {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

// The Italian collation at base strength where the runtime has one (Node; the
// worklet may be built without it): then the names it calls equal are one name.
const COLLATOR = (() => {
  try {
    if (typeof Intl === 'object' && Intl !== null && typeof Intl.Collator === 'function') return new Intl.Collator('it', { sensitivity: 'base' })
  } catch {}
  return null
})()

/** Whether two names are the same name to a reader (case and accents aside). */
export function sameName (a, b) {
  return foldName(a) === foldName(b) || (COLLATOR !== null && COLLATOR.compare(a, b) === 0)
}

/** An order of people by name, then by profile id. */
export function byName (a, b) {
  const fa = foldName(a.name)
  const fb = foldName(b.name)
  if (fa !== fb) return fa < fb ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * The tag that tells apart people with the same name: for each of `all` ({ id,
 * name }, you among them) that shares its name with another one, the first 4
 * characters of the profile ID, or all 8 when another of those also shares the
 * first 4; null for everyone else. Returns Map id -> tag.
 */
export function nameTags (all) {
  const tags = new Map()
  for (const p of all) tags.set(p.id, null)
  // Equal names sit next to each other once sorted by the same comparison.
  const compare = COLLATOR !== null
    ? (a, b) => COLLATOR.compare(a.name, b.name) || (foldName(a.name) < foldName(b.name) ? -1 : foldName(a.name) > foldName(b.name) ? 1 : 0)
    : (a, b) => (foldName(a.name) < foldName(b.name) ? -1 : foldName(a.name) > foldName(b.name) ? 1 : 0)
  const sorted = all.slice().sort(compare)
  let i = 0
  while (i < sorted.length) {
    let j = i + 1
    while (j < sorted.length && sameName(sorted[i].name, sorted[j].name)) j++
    if (j - i > 1) {
      const group = sorted.slice(i, j).map((p) => ({ id: p.id, text: profileIdText(p.id) }))
      for (const p of group) {
        const short = p.text.slice(0, 4)
        const clash = group.some((q) => q.id !== p.id && q.text.slice(0, 4) === short)
        tags.set(p.id, clash ? p.text : short)
      }
    }
    i = j
  }
  return tags
}

// ----------------------------------------------------------------- the union

/**
 * A play as a source serves it (now, last, a page's recent), its time moved to
 * this device's clock (`offset` = local time - the source's time when it
 * answered); null when it is not one. `withPage`: keep artistPage (recent plays).
 */
export function playOf (x, offset, withPage) {
  if (!plainObject(x) || typeof x.trackId !== 'string' || !HEX24_RE.test(x.trackId)) return null
  if (typeof x.title !== 'string' || typeof x.artist !== 'string' || typeof x.album !== 'string') return null
  if (!Number.isSafeInteger(x.at)) return null
  const out = { trackId: x.trackId, title: x.title, artist: x.artist, album: x.album, at: Math.round(x.at + offset) }
  if (withPage) out.artistPage = x.artistPage === true
  return out
}

/**
 * The union of the people answers of the social sources.
 * answers: [{ source, offset, people }] as each source answered GET /api/people
 * (or one person of a page). Per profileId: the newest valid card, seen "all"
 * when any source says so, the newest now and last by this device's clock, the
 * sources that list the person. A person with a bad card on one source is left
 * out from that source only (`onBad(source, profileId)`). `self` never counts.
 * @returns {Map<string, { card, seen, now, last, sources }>}
 */
export function unitePeople (answers, { self = null, now = Date.now(), onBad = () => {} } = {}) {
  const out = new Map()
  for (const a of answers) {
    for (const p of Array.isArray(a.people) ? a.people : []) {
      if (!plainObject(p) || typeof p.profileId !== 'string' || !HEX32_RE.test(p.profileId) || p.profileId === self) continue
      if (!checkCard(p.card, now) || p.card.profileId !== p.profileId) {
        onBad(a.source, p.profileId)
        continue
      }
      let e = out.get(p.profileId)
      if (e === undefined) {
        e = { card: null, seen: 'chat', now: null, last: null, sources: [] }
        out.set(p.profileId, e)
      }
      if (cardWins(p.card, e.card)) e.card = p.card
      if (p.seen !== 'chat') e.seen = 'all'
      const n = playOf(p.now, a.offset, false)
      if (n !== null && now - n.at <= NOW_KEPT_MS && (e.now === null || n.at > e.now.at)) e.now = n
      const l = playOf(p.last, a.offset, true)
      if (l !== null && (e.last === null || l.at > e.last.at)) e.last = l
      if (!e.sources.includes(a.source)) e.sources.push(a.source)
    }
  }
  return out
}

/**
 * The recent plays of the pages of one person: [{ offset, recent }] -> distinct
 * tracks, the newest play of each, newest first, at most 20.
 */
export function uniteRecent (pages) {
  const best = new Map()
  for (const page of pages) {
    for (const x of Array.isArray(page.recent) ? page.recent : []) {
      const r = playOf(x, page.offset, true)
      if (r === null) continue
      const had = best.get(r.trackId)
      if (had === undefined || r.at > had.at) best.set(r.trackId, r)
    }
  }
  return [...best.values()].sort((a, b) => b.at - a.at).slice(0, MAX_PAGE_RECENT)
}

/** The SHA-256 of some bytes, 64 hex. */
export function sha256Hex (bytes) {
  const out = b4a.alloc(sodium.crypto_hash_sha256_BYTES)
  sodium.crypto_hash_sha256(out, bytes)
  return hex(out)
}

/** The photos of other people, by their hash: the latest 64 used. */
export class PhotoCache {
  constructor (max = PHOTO_CACHE) {
    this.max = max
    this._map = new Map()
  }

  get (hash) {
    const bytes = this._map.get(hash)
    if (bytes === undefined) return null
    this._map.delete(hash)
    this._map.set(hash, bytes)
    return bytes
  }

  set (hash, bytes) {
    this._map.delete(hash)
    this._map.set(hash, bytes)
    while (this._map.size > this.max) this._map.delete(this._map.keys().next().value)
  }

  get size () {
    return this._map.size
  }
}
