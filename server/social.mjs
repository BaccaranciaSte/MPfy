// The people of this source: what they show each other, and what they keep here
// for their own devices. One file per person, social/<profileId>.json (0600):
//   { schema: 1, card, privacy, blocked, mutes, recent }
// - card: the profile card the person's own app signed (name, photo, chat key),
//   checked before it is taken; null until one comes. The newest one wins.
// - privacy: { invisible, showNow, privateUntil, showRecent, updatedAt }: never
//   served to anyone else, applied here to everything others are served.
// - blocked: { ids, updatedAt }: the people this person blocked.
// - mutes: { box, updatedAt }: the conversations the person silenced, sealed by
//   their own devices with a key this source never has. Only its size and its
//   time are checked here.
// - recent: what they played lately (from their activity reports), newest first,
//   distinct tracks, at most 20, times on this source's clock.
// What is playing now lives in memory only (profileId -> the track and when it was
// reported): a restart forgets it, the next report (a minute away at most) brings
// it back.
// A record is made at the first social write of a profile and goes, at once, when
// the profile is removed. Unknown fields are kept. Each file is written atomically
// and alone, so a change costs the size of one person: within 2 s of a change of
// a card or of the settings, within 60 s when only `recent` changed, so the
// reports of people playing do not rewrite it every few seconds on a phone (a
// crash loses a minute of recent plays at most). A file that does not parse is set
// aside as <profileId>.json.corrupt-<time> and that person begins again: their
// apps publish again at their next sync.
// A social.json found at start (one file for everyone, as sources wrote it
// before) is split into these files, then set aside as social.json.migrated-<time>.
//
// Who sees what: every answer is built for the asking profile (people, person).
// An invisible profile is in no list and has no page, except as "chat": listed
// (name and photo only) to the people it wrote to here, and to every member when
// it wrote in this source's group or holds its silent entry there (chat.mjs). A
// private session or a switch turned off hides what is playing and the recent
// plays; a block in either direction hides them too, never the name or the photo.

import fs from 'node:fs'
import path from 'node:path'
import sodium from 'sodium-native'
import { apiError } from './errors.mjs'
import { isProfileId, isPublicKey, isTrackId } from './ids.mjs'
import { profileIdOf } from './proof.mjs'
import { cleanName, cleanLine, codePoints, writeAtomicSync, renameSyncRetry, ensureDir, log, logError } from './util.mjs'

/** What this source speaks of the social part: 1 people, 2 chats, 3 songs (comments and lyrics). */
export const SOCIAL_VERSION = 3
// A time a client sends may be this far ahead of this source's clock.
export const AHEAD_MS = 5 * 60 * 1000
// A private session lasts 6 hours: its end may be that far ahead, plus the clocks.
export const PRIVATE_AHEAD_MS = 6 * 3600 * 1000 + AHEAD_MS
// "Now" is a report of the last two minutes.
export const NOW_MS = 120 * 1000
export const MAX_RECENT = 20
// A guard on the file: nobody blocks this many people.
export const MAX_BLOCKED = 10000
export const MAX_MUTES_BYTES = 64 * 1024
const MAX_TEXT = 200
// Writes per profile in any minute: chat writes (messages, deletes, read marks),
// comment writes, activity reports, card or settings writes.
export const RATE_LIMITS = Object.freeze({ chat: 60, comment: 20, activity: 12, card: 10 })
const MINUTE = 60 * 1000
const CARD_DELAY_MS = 2000
const RECENT_DELAY_MS = 60 * 1000
const RETRY_WRITE_MS = 1000

const CARD_KEYS = ['v', 'profileId', 'signPublicKey', 'chatPublicKey', 'name', 'photo', 'updatedAt', 'sig']
const PRIVACY_KEYS = ['invisible', 'showNow', 'privateUntil', 'showRecent', 'updatedAt']
const SECTIONS = ['privacy', 'blocked', 'mutes']
const ACTIVITY_KEYS = ['track', 'playing', 'now', 'recent']
const TRACK_KEYS = ['trackId', 'title', 'artist', 'album']
const HASH_RE = /^[0-9a-f]{64}$/
const FILE_RE = /^([0-9a-f]{32})\.json$/
const SIG_RE = /^[0-9a-f]{128}$/
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const TAG_CARD = Buffer.from('mpfy/card/1', 'ascii')

export function defaultPrivacy () {
  return { invisible: false, showNow: true, privateUntil: 0, showRecent: true, updatedAt: 0 }
}

function plainObject (v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

// Exactly these keys (any order), the optional ones allowed.
function hasKeys (obj, keys, optional = []) {
  const got = Object.keys(obj)
  return keys.every((k) => Object.prototype.hasOwnProperty.call(obj, k)) &&
    got.every((k) => keys.includes(k) || optional.includes(k))
}

function wholeTime (v) {
  return Number.isSafeInteger(v) && v >= 0
}

// ------------------------------------------------------------------- cards

/** The bytes a card's signature covers: "mpfy/card/1" || UTF-8 of the JSON array. */
export function cardBytes (card) {
  const list = [1, card.profileId, card.chatPublicKey, card.name, card.photo, card.updatedAt]
  return Buffer.concat([TAG_CARD, Buffer.from(JSON.stringify(list), 'utf8')])
}

// Everything of a card but its time and its signature.
function cardShape (card) {
  return plainObject(card) && hasKeys(card, CARD_KEYS) && card.v === 1 &&
    isPublicKey(card.signPublicKey) && isPublicKey(card.chatPublicKey) &&
    isProfileId(card.profileId) && profileIdOf(Buffer.from(card.signPublicKey, 'hex')) === card.profileId &&
    typeof card.name === 'string' && cleanName(card.name) === card.name &&
    (card.photo === null || (typeof card.photo === 'string' && HASH_RE.test(card.photo))) &&
    typeof card.updatedAt === 'number' && typeof card.sig === 'string' && SIG_RE.test(card.sig)
}

/**
 * What is wrong with a card, as the code of the answer: 'bad_card', 'bad_time'
 * (its time is not whole milliseconds above 0, or more than 5 minutes ahead of
 * `now`), or null when the card is valid.
 */
export function cardProblem (card, now = Date.now()) {
  if (!cardShape(card)) return 'bad_card'
  if (!Number.isSafeInteger(card.updatedAt) || card.updatedAt <= 0 || card.updatedAt > now + AHEAD_MS) return 'bad_time'
  let ok = false
  try {
    ok = sodium.crypto_sign_verify_detached(Buffer.from(card.sig, 'hex'), cardBytes(card), Buffer.from(card.signPublicKey, 'hex'))
  } catch {
    ok = false
  }
  return ok ? null : 'bad_card'
}

/** Whether card `a` wins over `b` (null: none): the newer time, at the same time the greater signature. */
export function cardWins (a, b) {
  return b === null || a.updatedAt > b.updatedAt || (a.updatedAt === b.updatedAt && a.sig > b.sig)
}

function copyCard (c) {
  return { v: 1, profileId: c.profileId, signPublicKey: c.signPublicKey, chatPublicKey: c.chatPublicKey, name: c.name, photo: c.photo, updatedAt: c.updatedAt, sig: c.sig }
}

// --------------------------------------------------------- what comes in

function badRequest () {
  return apiError('bad_request')
}

// A time field: a number that is not whole milliseconds, or out of its range, is a
// wrong time; anything else is a wrong shape.
function timeField (v, max) {
  if (typeof v !== 'number') throw badRequest()
  if (!wholeTime(v) || v > max) throw apiError('bad_time')
  return v
}

function readPrivacy (v, now) {
  if (!plainObject(v) || !hasKeys(v, PRIVACY_KEYS)) throw badRequest()
  if (typeof v.invisible !== 'boolean' || typeof v.showNow !== 'boolean' || typeof v.showRecent !== 'boolean') throw badRequest()
  const updatedAt = timeField(v.updatedAt, now + AHEAD_MS)
  const privateUntil = timeField(v.privateUntil, now + PRIVATE_AHEAD_MS)
  return { invisible: v.invisible, showNow: v.showNow, privateUntil, showRecent: v.showRecent, updatedAt }
}

function readBlocked (v, now, self) {
  if (!plainObject(v) || !hasKeys(v, ['ids', 'updatedAt']) || !Array.isArray(v.ids) || v.ids.length > MAX_BLOCKED) throw badRequest()
  const seen = new Set()
  for (const id of v.ids) {
    if (!isProfileId(id) || id === self || seen.has(id)) throw badRequest()
    seen.add(id)
  }
  return { ids: v.ids.slice(), updatedAt: timeField(v.updatedAt, now + AHEAD_MS) }
}

// The decoded size of a padded base64 string.
function base64Bytes (s) {
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0
  return (s.length / 4) * 3 - pad
}

function readMutes (v, now) {
  if (!plainObject(v) || !hasKeys(v, ['box', 'updatedAt'])) throw badRequest()
  const box = v.box
  if (box !== null) {
    // The length first: the regex never runs over a box far too big.
    if (typeof box !== 'string' || box.length === 0 || box.length > Math.ceil(MAX_MUTES_BYTES / 3) * 4 || !BASE64_RE.test(box)) throw badRequest()
    if (base64Bytes(box) > MAX_MUTES_BYTES) throw badRequest()
  }
  return { box, updatedAt: timeField(v.updatedAt, now + AHEAD_MS) }
}

// A text of a reported track: one line, at most 200 code points; `min` 1 for the title.
function trackText (v, min) {
  const s = cleanLine(v)
  if (s === null) throw badRequest()
  const n = codePoints(s)
  if (n < min || n > MAX_TEXT) throw badRequest()
  return s
}

/** The body of PUT /api/activity, checked and cleaned. Throws bad_request. */
export function readActivity (body) {
  if (!plainObject(body) || !hasKeys(body, ACTIVITY_KEYS)) throw badRequest()
  if (typeof body.playing !== 'boolean' || typeof body.now !== 'boolean' || typeof body.recent !== 'boolean') throw badRequest()
  let track = null
  const t = body.track
  if (t !== null) {
    if (!plainObject(t) || !hasKeys(t, TRACK_KEYS, ['artistPage']) || !isTrackId(t.trackId)) throw badRequest()
    if (t.artistPage !== undefined && typeof t.artistPage !== 'boolean') throw badRequest()
    track = { trackId: t.trackId, title: trackText(t.title, 1), artist: trackText(t.artist, 0), album: trackText(t.album, 0), artistPage: t.artistPage === true }
  }
  return { track, playing: body.playing, now: body.now, recent: body.recent }
}

// ------------------------------------------------------- what the file holds

function storedCard (card, pid) {
  return cardShape(card) && card.profileId === pid && Number.isSafeInteger(card.updatedAt) && card.updatedAt > 0 ? copyCard(card) : null
}

function storedPrivacy (p) {
  const d = defaultPrivacy()
  if (!plainObject(p)) return d
  return {
    invisible: typeof p.invisible === 'boolean' ? p.invisible : d.invisible,
    showNow: typeof p.showNow === 'boolean' ? p.showNow : d.showNow,
    privateUntil: wholeTime(p.privateUntil) ? p.privateUntil : 0,
    showRecent: typeof p.showRecent === 'boolean' ? p.showRecent : d.showRecent,
    updatedAt: wholeTime(p.updatedAt) ? p.updatedAt : 0
  }
}

function storedBlocked (b, pid) {
  if (!plainObject(b) || !Array.isArray(b.ids)) return { ids: [], updatedAt: 0 }
  const ids = [...new Set(b.ids.filter((id) => isProfileId(id) && id !== pid))].slice(0, MAX_BLOCKED)
  return { ids, updatedAt: wholeTime(b.updatedAt) ? b.updatedAt : 0 }
}

function storedMutes (m) {
  if (!plainObject(m)) return { box: null, updatedAt: 0 }
  const box = typeof m.box === 'string' && BASE64_RE.test(m.box) && base64Bytes(m.box) <= MAX_MUTES_BYTES ? m.box : null
  return { box, updatedAt: wholeTime(m.updatedAt) ? m.updatedAt : 0 }
}

function storedRecent (list) {
  const out = []
  const seen = new Set()
  for (const r of Array.isArray(list) ? list : []) {
    if (!plainObject(r) || !isTrackId(r.trackId) || seen.has(r.trackId) || !wholeTime(r.at)) continue
    if (typeof r.title !== 'string' || r.title === '' || typeof r.artist !== 'string' || typeof r.album !== 'string') continue
    seen.add(r.trackId)
    out.push({ trackId: r.trackId, title: r.title, artist: r.artist, album: r.album, artistPage: r.artistPage === true, at: r.at })
    if (out.length >= MAX_RECENT) break
  }
  return out
}

function newRecord () {
  return { card: null, privacy: defaultPrivacy(), blocked: { ids: [], updatedAt: 0 }, mutes: { box: null, updatedAt: 0 }, recent: [], extra: {}, blockedSet: null }
}

// A person's record from what a file (or the old social.json) held for them.
function recordOf (pid, r) {
  const { schema, card, privacy, blocked, mutes, recent, ...rest } = r
  return {
    card: storedCard(card, pid),
    privacy: storedPrivacy(privacy),
    blocked: storedBlocked(blocked, pid),
    mutes: storedMutes(mutes),
    recent: storedRecent(recent),
    extra: rest,
    blockedSet: null
  }
}

// ------------------------------------------------------------------ store

export class SocialStore {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir
   * @param {() => number} [opts.now]  this source's clock (tests)
   * @param {number} [opts.cardDelayMs=2000]  the write after a card or settings change
   * @param {number} [opts.recentDelayMs=60000]  the write after a change of `recent` only
   */
  constructor ({ dataDir, now = Date.now, cardDelayMs = CARD_DELAY_MS, recentDelayMs = RECENT_DELAY_MS }) {
    this.dataDir = dataDir
    this.dir = path.join(dataDir, 'social')
    this.oldFile = path.join(dataDir, 'social.json')
    this.now = now
    this.cardDelayMs = cardDelayMs
    this.recentDelayMs = recentDelayMs
    this._records = new Map() // profileId -> record
    this._playing = new Map() // profileId -> { trackId, title, artist, album, at }
    this._hits = new Map() // kind|profileId -> times of the last minute
    this._due = new Map() // profileId -> when its file is due (ms)
    this._timer = null
    this._timerAt = 0
    this._closed = false
    /** The chat store (chat.mjs), for who wrote where; set by the app. */
    this.chat = null
    /** Called after a change of a card or of someone's settings (the chat's waits). */
    this.onChange = () => {}
    /** How many files were written (diagnostics, tests). */
    this.writes = 0
    this._load()
  }

  /** The file of one person. */
  fileOf (pid) {
    return path.join(this.dir, pid + '.json')
  }

  _load () {
    ensureDir(this.dir)
    let names = []
    try {
      names = fs.readdirSync(this.dir)
    } catch (err) {
      logError('social folder not readable (' + err.message + '), starting without it')
    }
    for (const name of names) {
      const m = FILE_RE.exec(name)
      if (m === null) continue
      const file = path.join(this.dir, name)
      let raw = null
      try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      } catch (err) {
        if (err.code !== undefined) {
          logError('social file ' + name + ' not readable (' + err.message + '), left as it is')
          continue
        }
      }
      if (!plainObject(raw)) {
        this._setAside(file, name)
        continue
      }
      this._records.set(m[1], recordOf(m[1], raw))
    }
    this._migrate()
  }

  _setAside (file, name) {
    const aside = file + '.corrupt-' + Date.now()
    try {
      renameSyncRetry(file, aside)
      logError(name + ' did not parse, set aside as ' + path.basename(aside) + ': that person\'s apps publish again')
    } catch (err) {
      logError(name + ' did not parse and could not be set aside (' + err.message + ')')
    }
  }

  // social.json of an older source: every person to a file of their own (written
  // before the old file goes, so a crash in between only does it again), then the
  // old file set aside whole.
  _migrate () {
    let text
    try {
      text = fs.readFileSync(this.oldFile, 'utf8')
    } catch (err) {
      if (err.code !== 'ENOENT') logError('social.json not readable (' + err.message + '), left as it is')
      return
    }
    let raw = null
    try {
      raw = JSON.parse(text)
    } catch {}
    if (!plainObject(raw) || !plainObject(raw.profiles)) {
      this._setAside(this.oldFile, 'social.json')
      return
    }
    let n = 0
    for (const [pid, r] of Object.entries(raw.profiles)) {
      if (!isProfileId(pid) || !plainObject(r)) continue
      const record = recordOf(pid, r)
      this._records.set(pid, record)
      writeAtomicSync(this.fileOf(pid), JSON.stringify(this._data(record)))
      this.writes++
      n++
    }
    const aside = this.oldFile + '.migrated-' + Date.now()
    renameSyncRetry(this.oldFile, aside)
    log('social.json split into ' + n + ' file(s) under social/, the old file kept as ' + path.basename(aside))
  }

  _data (r) {
    return { ...r.extra, schema: 1, card: r.card, privacy: r.privacy, blocked: r.blocked, mutes: r.mutes, recent: r.recent }
  }

  _record (pid) {
    let r = this._records.get(pid)
    if (r === undefined) {
      r = newRecord()
      this._records.set(pid, r)
    }
    return r
  }

  // A person's file is due: within cardDelayMs for a card or settings change, else
  // within recentDelayMs (an earlier due time is kept).
  _changed (pid, urgent) {
    const due = Date.now() + (urgent ? this.cardDelayMs : this.recentDelayMs)
    const had = this._due.get(pid)
    if (had === undefined || due < had) this._due.set(pid, due)
    if (urgent) this.onChange()
    this._arm()
  }

  _arm () {
    if (this._closed || this._due.size === 0) return
    let next = Infinity
    for (const t of this._due.values()) if (t < next) next = t
    if (this._timer !== null) {
      if (this._timerAt <= next) return
      clearTimeout(this._timer)
    }
    this._timerAt = next
    this._timer = setTimeout(() => {
      this._timer = null
      this._flushDue(Date.now())
      this._arm()
    }, Math.max(0, next - Date.now()))
    // Never what keeps a process alive: close() writes what is left.
    if (typeof this._timer.unref === 'function') this._timer.unref()
  }

  _flushDue (time) {
    for (const [pid, t] of [...this._due]) {
      if (t > time) continue
      this._due.delete(pid)
      const r = this._records.get(pid)
      if (r === undefined) continue
      try {
        writeAtomicSync(this.fileOf(pid), JSON.stringify(this._data(r)))
        this.writes++
      } catch (err) {
        logError('social file of ' + pid + ' not written: ' + err.message)
        this._due.set(pid, time + RETRY_WRITE_MS)
      }
    }
  }

  /** Write now every file that changed. */
  flush () {
    this._flushDue(Infinity)
  }

  close () {
    this._closed = true
    if (this._timer !== null) clearTimeout(this._timer)
    this._timer = null
    this.flush()
  }

  // ---------------------------------------------------------------- limits

  /**
   * One write of `kind` (RATE_LIMITS) by a profile, or 429 slow_down with retryAt
   * (this source's clock) when its minute is full; a refused one does not count.
   */
  take (pid, kind) {
    const time = this.now()
    const key = kind + '|' + pid
    const hits = (this._hits.get(key) || []).filter((t) => time - t < MINUTE)
    if (hits.length >= RATE_LIMITS[kind]) {
      this._hits.set(key, hits)
      throw apiError('slow_down', { retryAt: hits[0] + MINUTE })
    }
    hits.push(time)
    this._hits.set(key, hits)
  }

  /** What memory no longer needs: minutes gone by, reports older than "now". */
  sweep () {
    const time = this.now()
    for (const [key, hits] of this._hits) if (hits.length === 0 || time - hits[hits.length - 1] >= MINUTE) this._hits.delete(key)
    for (const [pid, n] of this._playing) if (time - n.at > NOW_MS) this._playing.delete(pid)
  }

  // ------------------------------------------------------------ own data

  /** The times GET /api/profile carries, so a core asks more only when one differs. */
  stamps (pid) {
    const r = pid !== null ? this._records.get(pid) : undefined
    return {
      v: SOCIAL_VERSION,
      card: r !== undefined && r.card !== null ? r.card.updatedAt : 0,
      privacy: r !== undefined ? r.privacy.updatedAt : 0,
      blocked: r !== undefined ? r.blocked.updatedAt : 0,
      mutes: r !== undefined ? r.mutes.updatedAt : 0,
      // The time of this profile's silent entry in the group, 0 while it has none.
      access: pid !== null && this.chat !== null ? this.chat.accessAt(pid) : 0
    }
  }

  card (pid) {
    const r = this._records.get(pid)
    return r !== undefined && r.card !== null ? copyCard(r.card) : null
  }

  /** Take a card of profile `pid` when it is valid and newer; the card kept either way. */
  putCard (pid, card) {
    const problem = cardProblem(card, this.now())
    if (problem !== null) throw apiError(problem)
    if (card.profileId !== pid) throw apiError('bad_card')
    const r = this._record(pid)
    if (cardWins(card, r.card)) {
      r.card = copyCard(card)
      this._changed(pid, true)
    }
    return copyCard(r.card)
  }

  /** The three sections of a profile's settings (its own, never anyone else's). */
  settings (pid) {
    const r = this._records.get(pid) || newRecord()
    return { privacy: { ...r.privacy }, blocked: { ids: r.blocked.ids.slice(), updatedAt: r.blocked.updatedAt }, mutes: { ...r.mutes } }
  }

  /**
   * PUT /api/profile/social: every section sent is checked first, then each one
   * replaces the stored one when its time is newer. Throws bad_request, bad_time.
   */
  putSettings (pid, body) {
    if (!plainObject(body) || Object.keys(body).some((k) => !SECTIONS.includes(k))) throw badRequest()
    const now = this.now()
    const got = {}
    if (body.privacy !== undefined) got.privacy = readPrivacy(body.privacy, now)
    if (body.blocked !== undefined) got.blocked = readBlocked(body.blocked, now, pid)
    if (body.mutes !== undefined) got.mutes = readMutes(body.mutes, now)
    const before = this._records.get(pid)
    const newer = Object.keys(got).filter((k) => got[k].updatedAt > (before !== undefined ? before[k].updatedAt : 0))
    if (newer.length === 0) return this.settings(pid)
    const r = this._record(pid)
    for (const k of newer) r[k] = got[k]
    if (newer.includes('blocked')) r.blockedSet = null
    if (newer.includes('privacy')) {
      const p = r.privacy
      // What others must stop seeing goes now, not at the next report.
      if (!p.showNow || p.invisible || p.privateUntil > now) this._playing.delete(pid)
      if (!p.showRecent) r.recent = []
    }
    this._changed(pid, true)
    return this.settings(pid)
  }

  /** PUT /api/activity: what is playing and the recent plays, as the privacy allows. */
  activity (pid, body) {
    const a = readActivity(body)
    const time = this.now()
    const before = this._records.get(pid)
    const p = before !== undefined ? before.privacy : defaultPrivacy()
    if (p.invisible || p.privateUntil > time) return
    const t = a.track
    if (a.playing && t !== null && a.now && p.showNow) {
      this._playing.set(pid, { trackId: t.trackId, title: t.title, artist: t.artist, album: t.album, at: time })
    } else {
      this._playing.delete(pid)
    }
    if (a.playing && t !== null && a.recent && p.showRecent) {
      const r = this._record(pid)
      r.recent = [{ ...t, at: time }, ...r.recent.filter((x) => x.trackId !== t.trackId)].slice(0, MAX_RECENT)
      this._changed(pid, false)
    }
  }

  /** A profile leaves the source: its record, its file and what it was playing go now. */
  remove (pid) {
    this._playing.delete(pid)
    for (const kind of Object.keys(RATE_LIMITS)) this._hits.delete(kind + '|' + pid)
    this._due.delete(pid)
    const had = this._records.delete(pid)
    try {
      fs.unlinkSync(this.fileOf(pid))
    } catch (err) {
      if (err.code !== 'ENOENT') logError('social file of ' + pid + ' not removed: ' + err.message)
    }
    if (had) this.onChange()
  }

  // ------------------------------------------------------------ for the chats

  /** Whether `pid` has a card here. */
  hasCard (pid) {
    const r = this._records.get(pid)
    return r !== undefined && r.card !== null
  }

  /** The card of `pid` as it is kept (never to be changed), or null. */
  cardOf (pid) {
    const r = this._records.get(pid)
    return r !== undefined ? r.card : null
  }

  /** Whether `pid` is invisible. */
  invisible (pid) {
    const r = this._records.get(pid)
    return r !== undefined && r.privacy.invisible
  }

  /** Whether `pid` blocked `other`. */
  blocks (pid, other) {
    return this._blocks(pid, other)
  }

  /** A name of the state of `pid`'s blocks (it changes when they change). */
  blockStamp (pid) {
    const r = this._records.get(pid)
    return r !== undefined ? r.blocked.updatedAt : 0
  }

  /**
   * How `viewer` sees `pid` (a profile of the source, not removed): 'all', 'chat'
   * (invisible, but it wrote to `viewer` here or in the group), or null.
   */
  seen (viewer, pid) {
    const r = this._records.get(pid)
    if (r === undefined || r.card === null) return null
    if (!r.privacy.invisible) return 'all'
    return this.chat !== null && this.chat.chatSeen(pid, viewer) ? 'chat' : null
  }

  /**
   * The recipients of this source's group: every profile with a card not removed,
   * but an invisible one that never wrote there (nor holds its silent entry).
   */
  groupRecipients (active) {
    const out = []
    for (const pid of active) {
      const r = this._records.get(pid)
      if (r === undefined || r.card === null) continue
      if (r.privacy.invisible && (this.chat === null || !this.chat.inGroup(pid))) continue
      out.push(pid)
    }
    return out.sort()
  }

  // ------------------------------------------------------------ for others

  _blocks (pid, other) {
    const r = this._records.get(pid)
    if (r === undefined || r.blocked.ids.length === 0) return false
    if (r.blockedSet === null) r.blockedSet = new Set(r.blocked.ids)
    return r.blockedSet.has(other)
  }

  // What `viewer` is served of `pid` (a profile with a card, still here); null when
  // pid is invisible. The person themself is served what a member with no block
  // would get.
  _face (viewer, pid, r, time) {
    const p = r.privacy
    if (p.invisible) return null
    const quiet = p.privateUntil > time
    const blocked = viewer !== pid && (this._blocks(pid, viewer) || this._blocks(viewer, pid))
    const n = this._playing.get(pid)
    const now = p.showNow && !quiet && !blocked && n !== undefined && time - n.at <= NOW_MS
      ? { trackId: n.trackId, title: n.title, artist: n.artist, album: n.album, at: n.at }
      : null
    const recent = p.showRecent && !quiet && !blocked ? r.recent.map((x) => ({ ...x })) : []
    return { person: { profileId: pid, card: copyCard(r.card), seen: 'all', now, last: recent.length > 0 ? { ...recent[0] } : null }, recent }
  }

  /**
   * GET /api/people for `viewer`: everyone with a card it may see, itself left out.
   * An invisible person who wrote to it here (or in the group) is listed as "chat":
   * the name and the photo of the card, nothing of what they play.
   * `active`: the profiles of the source not removed.
   */
  people (viewer, active) {
    const time = this.now()
    const people = []
    for (const [pid, r] of this._records) {
      if (pid === viewer || r.card === null || !active.has(pid)) continue
      const face = this._face(viewer, pid, r, time)
      if (face !== null) people.push(face.person)
      else if (this.seen(viewer, pid) === 'chat') people.push({ profileId: pid, card: copyCard(r.card), seen: 'chat', now: null, last: null })
    }
    people.sort((a, b) => (a.profileId < b.profileId ? -1 : 1))
    return { time, people }
  }

  /** GET /api/people/<pid> for `viewer`: { time, person, recent }, or null (no page). */
  person (viewer, pid, active) {
    const r = this._records.get(pid)
    if (r === undefined || r.card === null || !active.has(pid)) return null
    const time = this.now()
    const face = this._face(viewer, pid, r, time)
    return face === null ? null : { time, person: face.person, recent: face.recent }
  }

  /** The hash of the card photo of `pid` while `viewer` lists it ("all" or "chat"), else null. */
  photoFor (viewer, pid, active) {
    if (!active.has(pid)) return null
    const r = this._records.get(pid)
    if (r === undefined || r.card === null) return null
    if (pid === viewer) return r.privacy.invisible ? null : r.card.photo
    return this.seen(viewer, pid) !== null ? r.card.photo : null
  }
}
