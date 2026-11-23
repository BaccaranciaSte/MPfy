// The chats of the client core: conversations written to every source that holds
// them, read back as one union, end to end (seal.js). The page talks plain text
// to /local/chat/*; the sources only ever see boxes.
//
// Where a conversation lives:
// - direct with P (id = directId of the two): every source at 2 or more that lists P;
// - a group: its source (its id from the source's key). Two or more sources whose
//   group has exactly the same people are one group: named after the principal
//   among them (else the oldest added), each message written to all of them with
//   `c` holding all their ids. When the people differ, they are apart again.
//
// Reading: per source and conversation a cursor (the last seq read). A list of a
// source (GET /api/chat/conversations) names each conversation's newest seq: what
// is above the cursor is read (`after`; from nothing, the newest 200 only), each box
// opened with the sender's key from the sender's signed card (never a key a source
// gives) and checked against its record (seal.js readMessage). Merged by id across
// sources, deletions applied wherever they come from, ordered by time then id.
// Memory only: the newest 200 per conversation, older pages read when the page asks
// and dropped 10 minutes after the chat was last asked, 5,000 at most. A
// conversation a source lists no more (gone there whole: the other person removed)
// leaves with what only that source held of it.
//
// A source of this kind can hold the list request until something changes (about
// 25 s at most): while the page or the notifier keep asking (in the last 20 s), the
// core keeps one such request open per source, so a message is known here the
// moment it lands, with one request every 25 s instead of one every 10 s. Nothing
// is asked once they stop asking: no timer of its own.
//
// Writing: one box per recipient (direct: the two; a group: its recipients that
// have a signed card from that source), POST to every source of the conversation.
// A source that is down, or answers 5xx or 429, gets it later from the outbox
// (<statePath>.chat-outbox.json: boxes only, never text), at its next link-up or
// list; a message deleted for everyone, here or from another device, leaves the
// outbox at once. Read marks travel the same way at each list; mutes and blocks are
// social settings (index.js).
//
// Portable: sodium-native, b4a, '#fs'.

import fs from '#fs'
import b4a from 'b4a'
import sodium from 'sodium-native'
import { HttpError } from './http.js'
import { writeFileAtomic } from './state.js'
import { sealBox, openBox, readMessage, MAX_PLAINTEXT_BYTES } from './seal.js'
import { directId, groupId, sha256Hex } from './people.js'

export const LIST_FRESH_MS = 8000
export const LIST_WAIT_MS = 3000
export const CHAT_FRESH_MS = 2500
export const GROUP_FRESH_MS = 60000
export const SEND_WAIT_MS = 4000
export const HOLD_SECONDS = 25
// The page (or the notifier) asked within this: the sources are watched.
export const WANTED_MS = 20000
export const OUTBOX_MAX = 500
export const OUTBOX_KEPT_MS = 30 * 24 * 3600 * 1000
export const KEEP_IDLE = 200
export const KEEP_MAX = 5000
export const IDLE_MS = 10 * 60 * 1000
export const SHARED_MAX = 12
export const MAX_TEXT = 2000
export const MAX_NOTE = 300
export const MAX_TITLE = 200
export const MAX_UNREAD = 999
const PAGE = 200
const REQUEST_TIMEOUT_MS = 8000
const HOLD_TIMEOUT_MS = (HOLD_SECONDS + 10) * 1000
// A 304 to a held list that came sooner than this: the source does not hold.
const HELD_MIN_MS = 15000
// A group's people read again before a message, at most this often per source.
const PEOPLE_AGAIN_MS = 2000
const FAILED_KEPT_MS = 2 * 60 * 1000
const REPLY_CHARS = 100
const PREVIEW_CHARS = 100
const DELETED_KEPT = 10000
const PLAYLISTS_KEPT = 32
// Sends of this run remembered (one id never sent twice): the oldest settled go.
const SENDS_KEPT = 500
const LOGGED_KEPT = 1000

const HEX8_RE = /^[0-9a-f]{8}$/
const HEX16_RE = /^[0-9a-f]{16}$/
const HEX24_RE = /^[0-9a-f]{24}$/
const HEX32_RE = /^[0-9a-f]{32}$/
const TAG_ACCESS = b4a.from('mpfy/chat-access/1')
// A middle dot between a name and its tag (built from its code point: this file stays ASCII).
const DOT = ' ' + String.fromCharCode(0xb7) + ' '
// Chat text: these go; a line break stays. Notes and titles: every one becomes a space.
const CHAT_DROP_RE = new RegExp('[\\u0000-\\u0009\\u000b-\\u001f\\u007f-\\u009f' + String.fromCharCode(0x2028, 0x2029) + ']', 'g')
const LINE_RE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f' + String.fromCharCode(0x2028, 0x2029) + ']', 'g')
const MUTES = { '8h': 8 * 3600 * 1000, '1w': 7 * 24 * 3600 * 1000, always: 0, off: null }
const OPS = new Set(['post', 'delete', 'read'])
const noop = () => {}

const hex = (bytes) => b4a.toString(bytes, 'hex')
const chars = (s) => Array.from(s).length
const cut = (s, n) => Array.from(s).slice(0, n).join('')

function plainObject (v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function badRequest () {
  return new HttpError(400, 'Richiesta non valida', 'bad_request')
}

function notFound () {
  return new HttpError(404, 'Conversazione non trovata', 'not_found')
}

// (at, id) after (at, id): the later one.
function later (a, b) {
  return b === null || b === undefined || a.at > b.at || (a.at === b.at && a.id > b.id)
}

function byTime (a, b) {
  return a.at !== b.at ? a.at - b.at : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function delay (ms) {
  let timer = null
  const p = new Promise((resolve) => { timer = setTimeout(resolve, ms) })
  return { p, cancel: () => clearTimeout(timer) }
}

// Wait for `promise`, at most `ms`; never rejects.
function within (promise, ms) {
  const d = delay(ms)
  return Promise.race([Promise.resolve(promise).then(noop, noop), d.p]).then(d.cancel)
}

function parseJson (bytes) {
  try {
    const v = JSON.parse(b4a.toString(bytes, 'utf8'))
    return v !== null && typeof v === 'object' ? v : null
  } catch {
    return null
  }
}

// ------------------------------------------------------------------- texts

/** Chat text: \r\n and \r become \n, other controls and the two line separators go, trimmed. */
export function cleanChatText (s) {
  return String(s).replace(/\r\n?/g, '\n').replace(CHAT_DROP_RE, '').trim()
}

/** A note or a title: every control and line break a space, spaces collapsed, trimmed. */
export function cleanLine (s) {
  return String(s).replace(LINE_RE, ' ').replace(/\s+/g, ' ').trim()
}

// A text of a card: one line of `min` to 200 code points, else null.
function cardText (v, min) {
  if (typeof v !== 'string') return null
  const s = cleanLine(v)
  const n = chars(s)
  return n >= min && n <= MAX_TITLE ? s : null
}

/**
 * A card as it goes in a message, from what the page sent (or a message holds):
 * track { kind, id (24 hex), title, sub }, album { kind, id (16 hex), title, sub },
 * playlist { kind, id (16 hex), title, sub: "", n, sources, cover }. null when it
 * is not one. `sources` is kept as it came (the core sets it when it sends).
 */
export function cleanCard (c) {
  if (!plainObject(c)) return null
  const title = cardText(c.title, 1)
  if (title === null) return null
  if (c.kind === 'track' || c.kind === 'album') {
    const re = c.kind === 'track' ? HEX24_RE : HEX16_RE
    const sub = c.sub === undefined || c.sub === null ? '' : cardText(c.sub, 0)
    if (typeof c.id !== 'string' || !re.test(c.id) || sub === null) return null
    return { kind: c.kind, id: c.id, title, sub }
  }
  if (c.kind === 'playlist') {
    if (typeof c.id !== 'string' || !HEX16_RE.test(c.id) || !Number.isSafeInteger(c.n) || c.n < 0) return null
    const sources = Array.isArray(c.sources) ? [...new Set(c.sources.filter((s) => typeof s === 'string' && HEX8_RE.test(s)))].slice(0, 16) : []
    const cover = typeof c.cover === 'string' && HEX24_RE.test(c.cover) ? c.cover : null
    return { kind: 'playlist', id: c.id, title, sub: '', n: c.n, sources, cover }
  }
  return null
}

// A quoted message as a message holds it: { id, from, text?, card? }.
function cleanReply (r) {
  if (!plainObject(r) || typeof r.id !== 'string' || !HEX32_RE.test(r.id) || typeof r.from !== 'string' || !HEX32_RE.test(r.from)) return null
  const out = { id: r.id, from: r.from }
  if (typeof r.text === 'string') out.text = cut(r.text, REPLY_CHARS)
  if (plainObject(r.card) && ['track', 'album', 'playlist'].includes(r.card.kind) && typeof r.card.id === 'string' && /^[0-9a-f]{16,24}$/.test(r.card.id)) {
    const title = cardText(r.card.title, 1)
    if (title !== null) out.card = { kind: r.card.kind, id: r.card.id, title }
  }
  return out
}

/**
 * What a message holds, once its box opened and its record checked: { t, text,
 * card, reply } or null when its content is not a message of ours.
 */
export function contentOf (msg) {
  if (msg.t === 'text') {
    if (typeof msg.text !== 'string') return null
    const n = chars(msg.text)
    if (n < 1 || n > MAX_TEXT) return null
    return { t: 'text', text: msg.text, card: null, reply: msg.reply === undefined ? null : cleanReply(msg.reply) }
  }
  if (msg.t === 'card') {
    const card = cleanCard(msg.card)
    if (card === null) return null
    let text = null
    if (msg.text !== undefined) {
      if (typeof msg.text !== 'string' || chars(msg.text) < 1 || chars(msg.text) > MAX_NOTE) return null
      text = msg.text
    }
    return { t: 'card', text, card, reply: msg.reply === undefined ? null : cleanReply(msg.reply) }
  }
  return null
}

/** The line a message shows in a list or a notification. */
export function previewOf (m) {
  if (m.t === 'card') {
    const word = m.card.kind === 'track' ? 'Brano' : m.card.kind === 'album' ? 'Album' : 'Playlist'
    return word + ': ' + m.card.title
  }
  return cut(m.text, PREVIEW_CHARS)
}

/**
 * The plaintext of a message, as its boxes hold it: the JSON of { v: 1, id, from,
 * at, c, t, card?, text?, reply? } in that order.
 */
export function buildPlaintext ({ id, from, at, c, t, text = null, card = null, reply = null }) {
  const plain = { v: 1, id, from, at, c, t }
  if (card !== null) plain.card = card
  if (text !== null) plain.text = text
  if (reply !== null) plain.reply = reply
  return b4a.from(JSON.stringify(plain), 'utf8')
}

/** The bytes an access entry signs: "mpfy/chat-access/1" || the JSON of [1, profileId, groupId, at]. */
export function accessBytes (profileId, gid, at) {
  return b4a.concat([TAG_ACCESS, b4a.from(JSON.stringify([1, profileId, gid, at]), 'utf8')])
}

/** The silent entry of a profile in a source's group: { at, sig }. */
export function makeAccess (keys, gid, at) {
  const sig = b4a.alloc(sodium.crypto_sign_BYTES)
  sodium.crypto_sign_detached(sig, accessBytes(keys.id, gid, at), keys.signSecretKey)
  return { at, sig: hex(sig) }
}

// ------------------------------------------------------------------ the chats

export class Chats {
  /**
   * @param {object} core  the client core (index.js): its state, its sources, the
   *   people union, its keys and its log
   * @param {object} [opts]
   * @param {string} opts.outboxPath
   * @param {number} [opts.listFreshMs]
   * @param {number} [opts.holdSeconds]
   * @param {number} [opts.groupFreshMs]
   */
  constructor (core, { outboxPath, listFreshMs = LIST_FRESH_MS, holdSeconds = HOLD_SECONDS, groupFreshMs = GROUP_FRESH_MS } = {}) {
    this.core = core
    this.outboxPath = outboxPath
    this.listFreshMs = listFreshMs
    this.holdSeconds = holdSeconds
    this.groupFreshMs = groupFreshMs
    this._src = new Map() // source id -> what this core knows of its chats
    this._convs = new Map() // conversation id (direct id, or a source's group id) -> cache
    this._deleted = new Map() // message id -> when its deletion was seen
    this._marks = new Map() // conversation id -> the newest read mark { at, id }
    this._sends = new Map() // message id -> a send of this device under way or done
    this._playlists = new Map() // message id -> { etag, playlist } the last copy read
    this._logged = new Set()
    this._askedAt = 0
    this._viewCache = new Map()
    this._outbox = []
    this._outboxChain = Promise.resolve()
    this._outboxDirty = false
    this._loadOutbox()
  }

  _log (line) {
    this.core._log(line)
  }

  // Once per key (a message that does not open, a recipient without a card).
  _logOnce (key, line) {
    if (this._logged.has(key)) return
    if (this._logged.size >= LOGGED_KEPT) this._logged.clear()
    this._logged.add(key)
    this._log(line)
  }

  // ------------------------------------------------------------ the outbox

  _loadOutbox () {
    let raw = null
    try {
      raw = JSON.parse(b4a.toString(fs.readFileSync(this.outboxPath), 'utf8'))
    } catch (err) {
      if (err && err.code !== 'ENOENT') this._log('chat outbox not read (' + (err.code || err.message) + '), starting empty')
    }
    const now = Date.now()
    for (const e of Array.isArray(raw) ? raw : []) {
      if (!plainObject(e) || typeof e.source !== 'string' || !HEX8_RE.test(e.source) || typeof e.cid !== 'string' || !HEX32_RE.test(e.cid)) continue
      if (!OPS.has(e.op) || !plainObject(e.body) || !Number.isSafeInteger(e.at) || now - e.at > OUTBOX_KEPT_MS) continue
      this._outbox.push({ source: e.source, cid: e.cid, op: e.op, body: e.body, at: e.at })
    }
    this._outbox = this._outbox.slice(-OUTBOX_MAX)
  }

  // The file follows the list; changes made together are written once.
  _saveOutbox () {
    this._outboxDirty = true
    this._outboxChain = this._outboxChain.then(async () => {
      if (!this._outboxDirty) return
      this._outboxDirty = false
      const list = this._outbox.slice()
      try {
        if (list.length === 0) {
          try {
            fs.unlinkSync(this.outboxPath)
          } catch {}
          return
        }
        await writeFileAtomic(this.outboxPath, b4a.from(JSON.stringify(list), 'utf8'))
      } catch (err) {
        this._log('chat outbox not written (' + ((err && (err.code || err.message)) || err) + ')')
      }
    })
    return this._outboxChain
  }

  _queue (entry) {
    this._outbox.push(entry)
    while (this._outbox.length > OUTBOX_MAX) this._outbox.shift()
    this._saveOutbox()
  }

  /** What is in the outbox now (tests, diagnostics). */
  outbox () {
    return this._outbox.map((e) => ({ ...e }))
  }

  /** Everything written lands. */
  settle () {
    return this._outboxChain
  }

  // Send what waits for one source, in order, one at a time. A source that is down,
  // or answers 5xx or 429, keeps the rest for later; another 4xx drops that entry.
  async _flushOutbox (rt) {
    const src = this._srcOf(rt)
    if (src.flushing || !this._outbox.some((e) => e.source === rt.id)) return
    src.flushing = true
    try {
      for (;;) {
        const e = this._outbox.find((x) => x.source === rt.id)
        if (e === undefined || !this.core._live(rt) || !rt.link.status.connected) break
        if (Date.now() - e.at > OUTBOX_KEPT_MS) {
          this._drop(e)
          continue
        }
        let res
        try {
          res = await this._ask(rt, e.op === 'post' ? 'POST' : e.op === 'delete' ? 'DELETE' : 'PUT', pathOf(e), e.op === 'delete' ? null : e.body)
        } catch {
          break
        }
        if (res.status >= 500 || res.status === 429) break
        this._drop(e)
        const ok = res.status >= 200 && res.status < 300
        if (!ok) this._log('chat: a ' + e.op + ' for ' + rt.id + ' refused (' + res.status + '), left out')
        if (e.op === 'post') this._settled(e.body.id, rt.id, ok ? 'sent' : 'refused')
      }
    } finally {
      src.flushing = false
    }
  }

  _drop (e) {
    const i = this._outbox.indexOf(e)
    if (i !== -1) {
      this._outbox.splice(i, 1)
      this._saveOutbox()
    }
  }

  // ---------------------------------------------------------------- sources

  _srcOf (rt) {
    let src = this._src.get(rt.id)
    if (src === undefined) {
      src = { id: rt.id, list: null, listFetch: null, group: null, groupFetch: null, convs: new Map(), watching: false, holds: null, flushing: false }
      this._src.set(rt.id, src)
    }
    return src
  }

  _profile () {
    return this.core._state.profile
  }

  // The runtimes of the sources that speak chats (2 or more), not being removed.
  _runtimes () {
    const out = []
    const st = this.core._state
    if (st === null) return out
    for (const s of st.sources) {
      if (!(s.social >= 2)) continue
      const rt = this.core._sources.get(s.id)
      if (rt !== undefined && rt.removing === null && !rt.closed) out.push(rt)
    }
    return out
  }

  /** Whether chats can be used: a profile and a source at 2 or more. */
  supported () {
    const st = this.core._state
    return st !== null && st.profile !== null && st.sources.some((s) => s.social >= 2)
  }

  async _ask (rt, method, path, body = null, { headers = {}, timeout = REQUEST_TIMEOUT_MS } = {}) {
    return rt.link.request(method, path, { headers: { ...(this.core._proofHeaders(rt) || {}), ...headers }, body, timeout })
  }

  // The source's list, when it was read for this profile.
  _listOf (src) {
    const p = this._profile()
    return src.list !== null && p !== null && src.list.profileId === p.id ? src.list : null
  }

  _groupOfSrc (src) {
    const p = this._profile()
    return src.group !== null && p !== null && src.group.profileId === p.id ? src.group : null
  }

  /** A link came up: what waits in the outbox for it goes now. */
  linkUp (rt) {
    const src = this._srcOf(rt)
    src.holds = null
    if (this.supported()) this._flushOutbox(rt).catch(noop)
  }

  /** A source left: its outbox entries and what was known of it go. */
  forgetSource (id) {
    this._src.delete(id)
    const before = this._outbox.length
    this._outbox = this._outbox.filter((e) => e.source !== id)
    if (this._outbox.length !== before) this._saveOutbox()
    this._viewCache.clear()
  }

  /** Another profile here (made, brought in, recovered): nothing of the last one stays. */
  reset () {
    this._src.clear()
    this._convs.clear()
    this._deleted.clear()
    this._marks.clear()
    this._sends.clear()
    this._playlists.clear()
    this._viewCache.clear()
    if (this._outbox.length > 0) {
      this._outbox = []
      this._saveOutbox()
    }
  }

  // ---------------------------------------------------------------- reading

  _wanted () {
    return Date.now() - this._askedAt < WANTED_MS
  }

  // Every connected source whose list is older than LIST_FRESH_MS (and not watched)
  // is read again; this waits LIST_WAIT_MS at most.
  async _refresh () {
    const due = []
    for (const rt of this._runtimes()) {
      if (!rt.link.status.connected) continue
      const src = this._srcOf(rt)
      const list = this._listOf(src)
      if (list === null || (!src.watching && Date.now() - list.at >= this.listFreshMs)) due.push(this._fetchList(rt))
      else this._watch(rt)
    }
    // The people too: their cards hold the keys.
    due.push(this.core._refreshPeople())
    await within(Promise.all(due), LIST_WAIT_MS)
  }

  _fetchList (rt) {
    const src = this._srcOf(rt)
    if (src.listFetch !== null) return src.listFetch
    const run = this._loadList(rt, src).catch((err) => {
      this._log('chats of ' + rt.id + ' not read (' + ((err && (err.detail || err.code || err.message)) || err) + ')')
    }).then(() => {
      src.listFetch = null
      this._watch(rt)
    })
    src.listFetch = run
    return run
  }

  async _loadList (rt, src, hold = false) {
    const profile = this._profile()
    if (profile === null) return null
    const list = this._listOf(src)
    const headers = list !== null && list.etag !== null ? { 'If-None-Match': list.etag } : {}
    const started = Date.now()
    const res = await this._ask(rt, 'GET', '/api/chat/conversations' + (hold ? '?wait=' + this.holdSeconds : ''), null, { headers, timeout: hold ? (this.holdSeconds + 10) * 1000 : REQUEST_TIMEOUT_MS })
    const at = Date.now()
    if (this._profile() === null || this._profile().id !== profile.id) return null
    if (res.status === 304 && list !== null) {
      list.at = at
      await this._afterList(rt, src)
      return { status: 304, ms: at - started }
    }
    const data = res.status === 200 ? parseJson(res.body) : null
    if (data === null || !Number.isSafeInteger(data.time) || !Array.isArray(data.conversations) || typeof data.group !== 'string') {
      this._log('chats of ' + rt.id + ' not read (' + res.status + ')')
      return null
    }
    const convs = new Map()
    for (const c of data.conversations) {
      if (!plainObject(c) || typeof c.id !== 'string' || !HEX32_RE.test(c.id) || !Number.isSafeInteger(c.seq)) continue
      if (c.kind === 'direct' && (typeof c.with !== 'string' || !HEX32_RE.test(c.with) || directId(profile.id, c.with) !== c.id)) continue
      if (c.kind === 'group' && c.id !== data.group) continue
      if (c.kind !== 'direct' && c.kind !== 'group') continue
      convs.set(c.id, c)
    }
    const etag = typeof res.headers.etag === 'string' && res.headers.etag !== '' ? res.headers.etag : null
    // What this source listed before and lists no more is gone there.
    if (list !== null) for (const cid of list.convs.keys()) if (!convs.has(cid)) this._forget(src, cid)
    src.list = { profileId: profile.id, etag, at, offset: at - data.time, group: data.group, convs }
    await this._afterList(rt, src)
    return { status: 200, ms: at - started }
  }

  // After a list: read marks both ways, the new records, the group's people when
  // older than a minute, the outbox.
  async _afterList (rt, src) {
    const list = this._listOf(src)
    if (list === null) return
    const work = []
    for (const c of list.convs.values()) {
      const theirs = plainObject(c.read) && Number.isSafeInteger(c.read.at) && typeof c.read.id === 'string' && HEX32_RE.test(c.read.id) ? { at: c.read.at, id: c.read.id } : null
      const mark = this._marks.get(c.id) || null
      if (theirs !== null && later(theirs, mark)) {
        this._marks.set(c.id, theirs)
        this._viewCache.clear()
      } else if (mark !== null && later(mark, theirs) && !c.markSent) {
        c.markSent = true
        work.push(this._ask(rt, 'PUT', '/api/chat/' + c.id + '/read', mark).then((res) => {
          if (res.status !== 200) this._log('chat: read mark not taken by ' + rt.id + ' (' + res.status + ')')
        }, noop))
      }
      work.push(this._pull(rt, src, c))
    }
    const g = this._groupOfSrc(src)
    if (g === null || Date.now() - g.at >= this.groupFreshMs) work.push(this._fetchGroup(rt))
    work.push(this._flushOutbox(rt))
    await Promise.all(work.map((p) => Promise.resolve(p).catch(noop)))
  }

  _fetchGroup (rt) {
    const src = this._srcOf(rt)
    if (src.groupFetch !== null) return src.groupFetch
    const profile = this._profile()
    const run = this._ask(rt, 'GET', '/api/chat/group').then((res) => {
      const data = res.status === 200 ? parseJson(res.body) : null
      if (data === null || typeof data.id !== 'string' || !Array.isArray(data.recipients)) {
        this._log('group of ' + rt.id + ' not read (' + res.status + ')')
        return
      }
      if (this._profile() === null || this._profile().id !== profile.id) return
      const recipients = [...new Set(data.recipients.filter((p) => typeof p === 'string' && HEX32_RE.test(p)))].sort()
      src.group = { profileId: profile.id, id: data.id, recipients, at: Date.now() }
      this._viewCache.clear()
    }, (err) => {
      this._log('group of ' + rt.id + ' not read (' + ((err && (err.code || err.message)) || err) + ')')
    }).then(() => {
      src.groupFetch = null
    })
    src.groupFetch = run
    return run
  }

  // One source watched: its list asked with `wait`, again and again while the page
  // keeps asking. A source that answers at once (it does not hold) is read the
  // ordinary way.
  _watch (rt) {
    const src = this._srcOf(rt)
    if (src.watching || src.holds === false || this._listOf(src) === null || !this._wanted()) return
    src.watching = true
    const loop = async () => {
      while (this._wanted() && this.core._live(rt) && rt.link.status.connected && src.holds !== false && this._listOf(src) !== null) {
        let r = null
        try {
          r = await this._loadList(rt, src, true)
        } catch {
          break
        }
        if (r === null) break
        if (r.status === 304 && r.ms < HELD_MIN_MS) {
          src.holds = false
          break
        }
        if (r.status === 304) src.holds = true
      }
    }
    loop().catch(noop).then(() => {
      src.watching = false
    })
  }

  // The records of one conversation of a source above its cursor.
  async _pull (rt, src, c) {
    let sc = src.convs.get(c.id)
    if (sc === undefined) {
      sc = { cursor: 0, oldest: null, complete: false, seqOf: new Map(), waiting: new Map(), readAt: 0, pulling: null }
      src.convs.set(c.id, sc)
    }
    // Records that waited for their sender's card: tried again.
    if (sc.waiting.size > 0) this._take(src, c.id, sc, [...sc.waiting.values()])
    if (c.seq <= sc.cursor) return
    // Only the newest message is new, and the list carries it: no request.
    if (c.seq === sc.cursor + 1 && recordShape(c.last) && c.last.seq === c.seq) {
      this._take(src, c.id, sc, [c.last])
      sc.cursor = c.seq
      return
    }
    await this._pullAfter(rt, src, c.id, sc, c.seq)
  }

  _pullAfter (rt, src, cid, sc, head) {
    if (sc.pulling !== null) return sc.pulling
    const run = (async () => {
      for (let pages = 0; pages < 3; pages++) {
        const jump = sc.cursor === 0 || head - sc.cursor > PAGE
        const q = jump ? '?before=' + (head + 1) + '&limit=' + PAGE : '?after=' + sc.cursor + '&limit=' + PAGE
        const res = await this._ask(rt, 'GET', '/api/chat/' + cid + '/messages' + q)
        const data = res.status === 200 ? parseJson(res.body) : null
        if (data === null || !Array.isArray(data.messages)) {
          this._log('chat ' + cid + ' of ' + rt.id + ' not read (' + res.status + ')')
          return
        }
        sc.readAt = Date.now()
        const records = data.messages.filter(recordShape)
        this._take(src, cid, sc, records)
        if (jump && sc.cursor > 0) this._dropBeforePage(cid, records)
        const top = records.reduce((m, r) => Math.max(m, r.seq), sc.cursor)
        if (jump) {
          sc.oldest = records.length > 0 ? records.reduce((m, r) => Math.min(m, r.seq), Infinity) : null
          sc.complete = data.more !== true
          sc.cursor = Math.max(top, Number.isSafeInteger(data.seq) ? data.seq : 0, sc.cursor)
          return
        }
        sc.cursor = Math.max(top, sc.cursor)
        if (data.more !== true) {
          if (Number.isSafeInteger(data.seq) && data.seq > sc.cursor) sc.cursor = data.seq
          return
        }
      }
    })().catch((err) => {
      this._log('chat ' + cid + ' of ' + rt.id + ' not read (' + ((err && (err.code || err.message)) || err) + ')')
    }).then(() => {
      sc.pulling = null
    })
    sc.pulling = run
    return run
  }

  // An older page of one conversation of a source (the page scrolled up).
  async _pullBefore (rt, src, cid, sc) {
    if (sc.complete || sc.oldest === null) return
    const res = await this._ask(rt, 'GET', '/api/chat/' + cid + '/messages?before=' + sc.oldest + '&limit=' + PAGE)
    const data = res.status === 200 ? parseJson(res.body) : null
    if (data === null || !Array.isArray(data.messages)) return
    const records = data.messages.filter(recordShape)
    this._take(src, cid, sc, records)
    if (records.length > 0) sc.oldest = Math.min(sc.oldest, records.reduce((m, r) => Math.min(m, r.seq), Infinity))
    if (data.more !== true) sc.complete = true
  }

  // Records of a source: deletions applied, boxes opened and checked.
  _take (src, cid, sc, records) {
    const profile = this._profile()
    if (profile === null) return
    const keys = this.core._keys()
    // A direct conversation holds only what its two people wrote: a box someone else
    // made for this profile, served there, is not shown under it.
    const direct = cid !== this._groupIdOfSource(src.id)
    let union = null
    for (const r of records) {
      sc.seqOf.set(r.id, r.seq)
      if (r.deleted === true) {
        sc.waiting.delete(r.id)
        this._applyDelete(r.id)
        continue
      }
      if (this._deleted.has(r.id)) continue
      if (direct && r.from !== profile.id && directId(profile.id, r.from) !== cid) {
        sc.waiting.delete(r.id)
        this._logOnce('drop|' + r.id, 'chat: a message ' + r.id + ' from ' + src.id + ' does not open or does not belong there: left out')
        continue
      }
      let senderKey = null
      if (r.from === profile.id) {
        senderKey = keys.chatPublicKey
      } else {
        if (union === null) union = this._union()
        const e = union.get(r.from)
        if (e !== undefined) senderKey = b4a.from(e.card.chatPublicKey, 'hex')
      }
      if (senderKey === null) {
        // Its sender's card is not known here yet: tried again at the next list.
        if (sc.waiting.size < PAGE) sc.waiting.set(r.id, r)
        continue
      }
      sc.waiting.delete(r.id)
      const plain = openBox(r.box, senderKey, keys.chatSecretKey)
      const msg = readMessage(plain, { id: r.id, from: r.from, at: r.at, conversation: cid })
      const content = msg === null ? null : contentOf(msg)
      if (content === null) {
        this._logOnce('drop|' + r.id, 'chat: a message ' + r.id + ' from ' + src.id + ' does not open or does not belong there: left out')
        continue
      }
      this._insert(cid, { id: r.id, from: r.from, at: r.at, c: msg.c.filter((x) => typeof x === 'string' && HEX32_RE.test(x)), ...content }, src.id)
    }
    // Past the 5,000: the oldest go, once for the whole page (never a sort per message).
    const conv = this._convs.get(cid)
    if (conv !== undefined && conv.msgs.size > KEEP_MAX) this._trim(conv, KEEP_MAX)
  }

  // The group id of a source of this profile, or null when it is not one.
  _groupIdOfSource (sourceId) {
    const st = this.core._state
    const s = st !== null ? st.sources.find((x) => x.id === sourceId) : undefined
    return s !== undefined ? groupId(s.serverPublicKey) : null
  }

  // After a jump over a gap (the newest page read, older records of this source
  // skipped), what this conversation held from before that page goes: a record in
  // the gap may delete one of them, and the gap itself would show as a hole. The
  // page reads them again from every source when it scrolls up.
  _dropBeforePage (cid, records) {
    const conv = this._convs.get(cid)
    if (conv === undefined) return
    let oldest = null
    for (const r of records) {
      const m = r.deleted === true ? undefined : conv.msgs.get(r.id)
      if (m !== undefined && (oldest === null || byTime(m, oldest) < 0)) oldest = m
    }
    // Kept: from the page's oldest message on (with none, only sends of this device
    // still under way, the newest of all).
    let keep = 0
    for (const m of conv.msgs.values()) {
      if (oldest !== null ? byTime(m, oldest) >= 0 : m.state !== 'sent') keep++
    }
    if (keep < conv.msgs.size) this._trim(conv, keep)
  }

  _cacheOf (cid) {
    let conv = this._convs.get(cid)
    if (conv === undefined) {
      conv = { id: cid, msgs: new Map(), version: 0, askedAt: 0 }
      this._convs.set(cid, conv)
    }
    return conv
  }

  _insert (cid, m, sourceId) {
    const conv = this._cacheOf(cid)
    const had = conv.msgs.get(m.id)
    if (had !== undefined) {
      if (sourceId !== null) had.sources.add(sourceId)
      if (had.state !== 'sent') {
        had.state = 'sent'
        conv.version++
      }
      return
    }
    conv.msgs.set(m.id, { ...m, state: 'sent', failedAt: 0, sources: new Set(sourceId === null ? [] : [sourceId]) })
    conv.version++
  }

  _applyDelete (id) {
    if (!this._deleted.has(id)) {
      this._deleted.set(id, Date.now())
      while (this._deleted.size > DELETED_KEPT) this._deleted.delete(this._deleted.keys().next().value)
    }
    for (const conv of this._convs.values()) {
      if (conv.msgs.delete(id)) conv.version++
    }
    // A copy still waiting in the outbox for a source never goes, wherever the
    // deletion came from (here, or another device of this profile through a source):
    // it leaves this device's disk too.
    const before = this._outbox.length
    this._outbox = this._outbox.filter((e) => !(e.op === 'post' && e.body.id === id))
    if (this._outbox.length !== before) this._saveOutbox()
  }

  // A conversation a source lists no more (gone there whole, a person removed; or
  // hidden there by a block): its cursor goes, and so does every message here that
  // only that source held. What other sources hold stays; the sends of this device
  // still under way stay.
  _forget (src, cid) {
    src.convs.delete(cid)
    const conv = this._convs.get(cid)
    if (conv === undefined) return
    let changed = false
    for (const m of [...conv.msgs.values()]) {
      if (!m.sources.delete(src.id) || m.sources.size > 0 || m.state !== 'sent') continue
      conv.msgs.delete(m.id)
      changed = true
    }
    if (changed) conv.version++
  }

  // Keep the newest `n` of a conversation; each source then reads older pages from
  // the oldest it still holds.
  _trim (conv, n) {
    if (conv.msgs.size <= n) return
    const list = [...conv.msgs.values()].sort(byTime)
    const gone = list.slice(0, list.length - n)
    for (const m of gone) conv.msgs.delete(m.id)
    conv.version++
    for (const src of this._src.values()) {
      const sc = src.convs.get(conv.id)
      if (sc === undefined) continue
      for (const m of gone) sc.seqOf.delete(m.id)
      let oldest = Infinity
      for (const [id, seq] of sc.seqOf) if (conv.msgs.has(id) && seq < oldest) oldest = seq
      // None of its messages left here: the older pages start below what was read.
      sc.oldest = oldest !== Infinity ? oldest : sc.cursor > 0 ? sc.cursor + 1 : null
      sc.complete = false
    }
  }

  // Older pages of a conversation the page has not asked for in 10 minutes go;
  // failed sends go 2 minutes after they failed.
  _tidy () {
    const now = Date.now()
    for (const conv of this._convs.values()) {
      if (now - conv.askedAt >= IDLE_MS && conv.msgs.size > KEEP_IDLE) this._trim(conv, KEEP_IDLE)
      for (const m of conv.msgs.values()) {
        if (m.state === 'failed' && now - m.failedAt >= FAILED_KEPT_MS) {
          conv.msgs.delete(m.id)
          conv.version++
        }
      }
    }
  }

  // ------------------------------------------------------------- the people

  _union () {
    return this.core._supported() ? this.core._union() : new Map()
  }

  _blocked () {
    return new Set(this.core._state.social.blocked.ids)
  }

  // A sender as the page shows them: the name and the tag.
  _nameOf (pid, union, tags) {
    const p = this._profile()
    let name = ''
    if (pid === p.id) name = p.name
    else {
      const e = union.get(pid)
      if (e === undefined) return ''
      name = e.card.name
    }
    const tag = tags.get(pid)
    return tag ? name + DOT + tag : name
  }

  // ------------------------------------------------------------------ views

  /**
   * The conversations as the page sees them: the groups (sources with the very
   * same people merged into one), and the direct ones with someone listed and not
   * blocked. Each { kind, id, ids, sources, with, name, lead }.
   */
  _views (union) {
    const st = this.core._state
    const blocked = this._blocked()
    const views = []
    const sources = st.sources.filter((s) => s.social >= 2 && this.core._sources.has(s.id))
    const buckets = new Map()
    for (const s of sources) {
      const src = this._src.get(s.id)
      const g = src !== undefined ? this._groupOfSrc(src) : null
      const key = g !== null ? 'p:' + g.recipients.join(',') : 's:' + s.id
      if (!buckets.has(key)) buckets.set(key, [])
      buckets.get(key).push(s)
    }
    for (const list of buckets.values()) {
      const lead = list.find((s) => s.principal) || list.slice().sort((a, b) => a.addedAt - b.addedAt || (a.id < b.id ? -1 : 1))[0]
      const ordered = [lead, ...list.filter((s) => s !== lead)]
      const ids = ordered.map((s) => groupId(s.serverPublicKey))
      views.push({ kind: 'group', id: ids[0], ids, sources: ordered.map((s) => s.id), sourceIds: ids, with: null, name: lead.name })
    }
    const directs = new Map()
    for (const s of sources) {
      const src = this._src.get(s.id)
      const list = src !== undefined ? this._listOf(src) : null
      if (list === null) continue
      for (const c of list.convs.values()) if (c.kind === 'direct') directs.set(c.id, c.with)
    }
    const me = st.profile.id
    for (const send of this._sends.values()) if (send.with !== null) directs.set(send.cid, send.with)
    for (const [cid, w] of directs) {
      if (blocked.has(w) || w === me) continue
      const e = union.get(w)
      if (e === undefined) continue
      views.push(this._directView(cid, w, e, sources))
    }
    return views
  }

  _directView (cid, w, e, sources) {
    const at2 = new Set(sources.map((s) => s.id))
    const ids = e.sources.filter((sid) => at2.has(sid))
    return { kind: 'direct', id: cid, ids: [cid], sources: ids, sourceIds: ids.map(() => cid), with: w, name: null }
  }

  // The view a /local/chat/<cid> names: any id of a view, or the direct id of
  // someone listed (a first message).
  _viewOf (cid, union) {
    const views = this._views(union)
    const v = views.find((x) => x.ids.includes(cid))
    if (v !== undefined) return v
    const me = this._profile().id
    const blocked = this._blocked()
    const sources = this.core._state.sources.filter((s) => s.social >= 2 && this.core._sources.has(s.id))
    for (const [pid, e] of union) {
      if (blocked.has(pid) || directId(me, pid) !== cid) continue
      const view = this._directView(cid, pid, e, sources)
      return view.sources.length > 0 ? view : null
    }
    return null
  }

  // The messages of a view, oldest first: merged by id, deleted and blocked left
  // out. Made again only when something in it changed.
  _messagesOf (view) {
    const blocked = this._blocked()
    const me = this._profile().id
    const key = view.ids.map((id) => {
      const c = this._convs.get(id)
      return id + ':' + (c === undefined ? 0 : c.version)
    }).join(',') + '|' + this.core._state.social.blocked.updatedAt
    const had = this._viewCache.get(view.id)
    if (had !== undefined && had.key === key) return had.list
    const seen = new Map()
    for (const id of view.ids) {
      const c = this._convs.get(id)
      if (c === undefined) continue
      for (const m of c.msgs.values()) {
        if (seen.has(m.id) || (m.from !== me && blocked.has(m.from))) continue
        seen.set(m.id, m)
      }
    }
    const list = [...seen.values()].sort(byTime)
    this._viewCache.set(view.id, { key, list })
    return list
  }

  _markOf (view) {
    let mark = null
    for (const id of view.ids) {
      const m = this._marks.get(id)
      if (m !== undefined && later(m, mark)) mark = m
    }
    return mark
  }

  // Messages from others after the mark, counted once. When the cache does not
  // reach back to the mark, what the sources count is taken when it is more.
  _unreadOf (view, list, mark) {
    const me = this._profile().id
    let n = 0
    for (let i = list.length - 1; i >= 0 && n < MAX_UNREAD; i--) {
      const m = list[i]
      if (mark !== null && !later(m, mark)) break
      if (m.from !== me && m.state === 'sent') n++
    }
    if (list.length > 0 && mark !== null && !later(list[0], mark)) return n
    // Whatever a source holds is here (every page read): the count is exact.
    let whole = true
    const counts = []
    for (let i = 0; i < view.sources.length; i++) {
      const src = this._src.get(view.sources[i])
      const list2 = src !== undefined ? this._listOf(src) : null
      const c = list2 !== null ? list2.convs.get(view.sourceIds[i]) : undefined
      if (c === undefined) continue
      const sc = src.convs.get(view.sourceIds[i])
      if (sc === undefined || !sc.complete || sc.cursor < c.seq) whole = false
      if (Number.isSafeInteger(c.unread)) counts.push(c.unread)
    }
    if (whole) return n
    for (const u of counts) if (u > n) n = Math.min(u, MAX_UNREAD)
    return n
  }

  _mutedUntil (view) {
    const map = this.core._state.social.mutes.map
    const now = Date.now()
    let until = null
    for (const id of view.ids) {
      if (!(id in map)) continue
      const u = map[id]
      if (u === 0) return 0
      if (u > now && (until === null || u > until)) until = u
    }
    return until
  }

  // A message as the page sees it.
  _m (m, union, tags) {
    const me = this._profile().id
    const out = { id: m.id, from: m.from, name: this._nameOf(m.from, union, tags), mine: m.from === me, at: m.at, t: m.t }
    if (m.text !== null) out.text = m.text
    if (m.card !== null) out.card = m.card
    // The quote of a message known to be deleted for everyone keeps its sender only:
    // its words and its card leave with it.
    if (m.reply !== null) out.reply = this._deleted.has(m.reply.id) ? { id: m.reply.id, from: m.reply.from, gone: true } : m.reply
    out.state = m.state
    out.preview = previewOf(m)
    return out
  }

  // ------------------------------------------------------------- endpoints

  /** GET /local/chat/conversations */
  async conversations () {
    const profile = this._profile()
    if (profile === null || !this.supported()) return [200, this._answer({ supported: false, unread: 0, conversations: [] })]
    this._askedAt = Date.now()
    await this._refresh()
    this._tidy()
    if (this._profile() === null || this._profile().id !== profile.id) throw new HttpError(503, 'Qualcosa non ha funzionato')
    const union = this._union()
    const tags = this.core._tags(union)
    const out = []
    let total = 0
    for (const view of this._views(union)) {
      const list = this._messagesOf(view).filter((m) => m.state !== 'failed')
      if (view.kind === 'direct' && list.length === 0) continue
      const mark = this._markOf(view)
      const unread = this._unreadOf(view, list, mark)
      const mutedUntil = this._mutedUntil(view)
      const muted = mutedUntil !== null
      if (!muted) total += unread
      const last = list.length > 0 ? list[list.length - 1] : null
      let display = view.name
      if (view.kind === 'direct') display = this._nameOf(view.with, union, tags)
      out.push({
        id: view.id,
        kind: view.kind,
        with: view.with,
        name: view.kind === 'group' ? view.name : null,
        display,
        sources: view.sources.slice(),
        ids: view.ids.slice(),
        last: last === null ? null : this._m(last, union, tags),
        unread,
        muted,
        mutedUntil,
        at: last === null ? 0 : last.at
      })
    }
    out.sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1))
    return [200, this._answer({ supported: true, unread: total, conversations: out })]
  }

  _answer (body) {
    const v = sha256Hex(b4a.from(JSON.stringify(body), 'utf8')).slice(0, 16)
    return { supported: body.supported, v, ...body }
  }

  /** GET /local/chat/<cid>/messages?limit=<n>&before=<messageId> */
  async messages (cid, query) {
    const profile = this._profile()
    if (profile === null || !this.supported()) throw notFound()
    const limit = query.limit === null ? 50 : wholeNumber(query.limit)
    if (limit === null || limit < 1) throw badRequest()
    const n = Math.min(limit, PAGE)
    const before = query.before
    if (before !== null && !HEX32_RE.test(before)) throw badRequest()
    this._askedAt = Date.now()
    let union = this._union()
    let view = this._viewOf(cid, union)
    if (view === null) {
      await this._refresh()
      union = this._union()
      view = this._viewOf(cid, union)
      if (view === null) throw notFound()
    }
    for (const id of view.ids) this._cacheOf(id).askedAt = Date.now()
    // This conversation, on the sources not read in the last 2.5 s and not watched.
    const work = [this._refresh()]
    for (let i = 0; i < view.sources.length; i++) {
      const rt = this.core._sources.get(view.sources[i])
      if (rt === undefined || !rt.link.status.connected) continue
      const src = this._srcOf(rt)
      const list = this._listOf(src)
      const c = list !== null ? list.convs.get(view.sourceIds[i]) : undefined
      const sc = src.convs.get(view.sourceIds[i])
      if (c === undefined || src.watching) continue
      if (sc === undefined || Date.now() - sc.readAt >= CHAT_FRESH_MS) work.push(this._pull(rt, src, c))
    }
    await within(Promise.all(work), LIST_WAIT_MS)
    let list = this._messagesOf(view)
    let end = list.length
    if (before !== null) {
      end = list.findIndex((m) => m.id === before)
      if (end === -1) end = list.length
    }
    // Not enough older ones here: the next older page from every source that has more.
    if (end < n) {
      const older = []
      for (let i = 0; i < view.sources.length; i++) {
        const rt = this.core._sources.get(view.sources[i])
        const src = rt !== undefined ? this._srcOf(rt) : null
        const sc = src !== null ? src.convs.get(view.sourceIds[i]) : undefined
        if (sc !== undefined && !sc.complete && rt.link.status.connected) older.push(this._pullBefore(rt, src, view.sourceIds[i], sc).catch(noop))
      }
      if (older.length > 0) {
        await within(Promise.all(older), LIST_WAIT_MS)
        list = this._messagesOf(view)
        end = before === null ? list.length : list.findIndex((m) => m.id === before)
        if (end === -1) end = list.length
      }
    }
    const start = Math.max(0, end - n)
    const tags = this.core._tags(union)
    const page = list.slice(start, end).map((m) => this._m(m, union, tags))
    let more = start > 0
    if (!more) {
      for (let i = 0; i < view.sources.length; i++) {
        const src = this._src.get(view.sources[i])
        const sc = src !== undefined ? src.convs.get(view.sourceIds[i]) : undefined
        if (sc !== undefined && !sc.complete && sc.oldest !== null && sc.oldest > 1) more = true
      }
    }
    const body = { messages: page, more }
    return [200, { v: sha256Hex(b4a.from(JSON.stringify(body), 'utf8')).slice(0, 16), ...body }]
  }

  /** POST /local/chat/<cid>/messages { id?, text?, card?, replyTo? } */
  async send (cid, body) {
    const profile = this._profile()
    if (profile === null || !this.supported()) throw notFound()
    for (const k of Object.keys(body)) if (!['id', 'text', 'card', 'replyTo'].includes(k)) throw badRequest()
    let id = body.id
    if (id !== undefined && id !== null && (typeof id !== 'string' || !HEX32_RE.test(id))) throw badRequest()
    // The same id again: that message, nothing sent twice.
    if (typeof id === 'string' && this._sends.has(id)) {
      const s = this._sends.get(id)
      if (s.cid !== cid && !s.ids.includes(cid)) throw badRequest()
      await within(s.answered, SEND_WAIT_MS)
      return [200, { message: this._sentM(s) }]
    }
    if (typeof id !== 'string') id = hex(randomId())
    // What the message says.
    let t = 'text'
    let text = null
    let card = null
    if (body.card !== undefined && body.card !== null) {
      card = cleanCard(body.card)
      if (card === null) throw badRequest()
      t = 'card'
      if (body.text !== undefined && body.text !== null) {
        if (typeof body.text !== 'string') throw badRequest()
        text = cleanLine(body.text)
        if (text === '') text = null
        else if (chars(text) > MAX_NOTE) throw badRequest()
      }
    } else {
      if (typeof body.text !== 'string') throw badRequest()
      text = cleanChatText(body.text)
      const n = chars(text)
      if (n < 1 || n > MAX_TEXT) throw badRequest()
    }
    const union = this._union()
    const view = this._viewOf(cid, union)
    if (view === null) throw notFound()
    let reply = null
    if (body.replyTo !== undefined && body.replyTo !== null) {
      if (typeof body.replyTo !== 'string' || !HEX32_RE.test(body.replyTo)) throw badRequest()
      const q = this._messagesOf(view).find((m) => m.id === body.replyTo)
      if (q === undefined) throw badRequest()
      reply = { id: q.id, from: q.from }
      const said = q.text !== null ? q.text : null
      if (said !== null) reply.text = cut(said, REPLY_CHARS)
      if (q.card !== null) reply.card = { kind: q.card.kind, id: q.card.id, title: q.card.title }
    }
    // Where it goes.
    const targets = []
    for (let i = 0; i < view.sources.length; i++) {
      const rt = this.core._sources.get(view.sources[i])
      if (rt !== undefined && rt.removing === null && !rt.closed) targets.push({ rt, scid: view.sourceIds[i] })
    }
    if (targets.length === 0) throw notFound()
    // A playlist is read from the sources that keep it and hold this conversation:
    // those the page named (its library there has it), else the principal. Each of
    // them is told the playlist id with the message, and serves it only when it
    // really holds it for this profile.
    if (card !== null && card.kind === 'playlist') {
      const holding = new Set(targets.map((x) => x.rt.id))
      const principal = this.core._state.sources.find((s) => s.principal)
      const named = card.sources.length > 0 ? card.sources : principal !== undefined ? [principal.id] : []
      card.sources = named.filter((sid) => holding.has(sid))
    }
    const at = Date.now()
    const bytes = buildPlaintext({ id, from: profile.id, at, c: view.ids.slice(), t, text, card, reply })
    if (bytes.byteLength > MAX_PLAINTEXT_BYTES) throw badRequest()

    const send = {
      id, cid: view.id, ids: view.ids.slice(), with: view.with, view: view.id, at, targets: new Map(),
      answered: null, msg: { id, from: profile.id, at, c: view.ids.slice(), t, text, card, reply, state: 'pending', failedAt: 0, sources: new Set() }
    }
    this._sends.set(id, send)
    if (this._sends.size > SENDS_KEPT) {
      for (const [k, s] of this._sends) {
        if (this._sends.size <= SENDS_KEPT) break
        if (s.msg.state !== 'pending') this._sends.delete(k)
      }
    }
    for (const scid of view.ids) this._cacheOf(scid).msgs.set(id, send.msg)
    for (const scid of view.ids) this._cacheOf(scid).version++
    // Sending moves the read mark to it.
    for (const scid of view.ids) {
      const had = this._marks.get(scid)
      if (later({ at, id }, had)) this._marks.set(scid, { at, id })
    }
    let answer = null
    send.answered = new Promise((resolve) => { answer = resolve })
    const posts = []
    const boxes = new Map() // profile -> box, the same for every source
    const keys = this.core._keys()
    const boxFor = (pid, publicKeyHex) => {
      if (!boxes.has(pid)) boxes.set(pid, sealBox(bytes, b4a.from(publicKeyHex, 'hex'), keys.chatSecretKey))
      return boxes.get(pid)
    }
    for (const { rt, scid } of targets) {
      send.targets.set(rt.id, 'pending')
      posts.push(this._postTo(rt, scid, view, send, union, boxFor, card).then((outcome) => {
        this._settled(id, rt.id, outcome)
        if (outcome === 'sent') answer()
      }))
    }
    Promise.all(posts).then(() => answer())
    await within(send.answered, SEND_WAIT_MS)
    return [201, { message: this._sentM(send) }]
  }

  // One source's copy: 'sent', 'refused', or 'queued' (in the outbox).
  async _postTo (rt, scid, view, send, union, boxFor, card) {
    const me = this._profile().id
    const keys = this.core._keys()
    const out = { id: send.id, at: send.at }
    const boxes = {}
    boxes[me] = boxFor(me, hex(keys.chatPublicKey))
    if (view.kind === 'direct') {
      const e = union.get(view.with)
      out.with = view.with
      boxes[view.with] = boxFor(view.with, e.card.chatPublicKey)
    } else {
      const src = this._srcOf(rt)
      let g = this._groupOfSrc(src)
      if ((g === null || Date.now() - g.at >= this.groupFreshMs) && rt.link.status.connected) {
        await within(this._fetchGroup(rt), REQUEST_TIMEOUT_MS)
        g = this._groupOfSrc(src)
      }
      // The group's people as the source said them; while they are not known (the
      // source down since this run began), everyone it lists with a card: the
      // source keeps only the boxes of its recipients.
      let recipients = g !== null ? g.recipients : null
      if (recipients === null) {
        recipients = []
        for (const [pid, e] of union) if (e.sources.includes(rt.id)) recipients.push(pid)
      }
      // Someone new in the group whose card this source has not listed here yet:
      // its people read again first (once, when not read in the last 2 s).
      const listed = (pid) => pid === me || (union.has(pid) && union.get(pid).sources.includes(rt.id))
      const people = this.core._peopleOf(rt)
      if (recipients.some((pid) => !listed(pid)) && rt.link.status.connected && (people === null || Date.now() - people.at >= PEOPLE_AGAIN_MS)) {
        await within(this.core._fetchPeople(rt), REQUEST_TIMEOUT_MS)
        union = this._union()
      }
      for (const pid of recipients) {
        if (pid === me) continue
        const e = union.get(pid)
        // Only someone whose signed card this source gave: never a key it lists alone.
        if (e === undefined || !e.sources.includes(rt.id)) {
          this._logOnce('nocard|' + rt.id + '|' + pid, 'chat: a recipient of the group of ' + rt.id + ' has no signed card from it: left out')
          continue
        }
        boxes[pid] = boxFor(pid, e.card.chatPublicKey)
      }
    }
    out.boxes = boxes
    if (card !== null && card.kind === 'playlist' && card.sources.includes(rt.id)) out.playlist = card.id
    const entry = { source: rt.id, cid: scid, op: 'post', body: out, at: send.at }
    if (!rt.link.status.connected || this._outbox.some((e) => e.source === rt.id)) {
      // Down, or older writes still wait for it: in order, after them.
      this._queue(entry)
      if (rt.link.status.connected) this._flushOutbox(rt).catch(noop)
      return 'queued'
    }
    let res
    try {
      res = await this._ask(rt, 'POST', '/api/chat/' + scid + '/messages', out)
    } catch {
      this._queue(entry)
      return 'queued'
    }
    if (res.status === 201 || res.status === 200) return 'sent'
    if (res.status >= 500 || res.status === 429) {
      this._queue(entry)
      return 'queued'
    }
    this._log('chat: a message for ' + rt.id + ' refused (' + res.status + ')')
    return 'refused'
  }

  // What became of one source's copy of a message sent here.
  _settled (id, sourceId, outcome) {
    const send = this._sends.get(id)
    if (send === undefined) return
    if (outcome !== 'queued') send.targets.set(sourceId, outcome)
    const states = [...send.targets.values()]
    const m = send.msg
    const before = m.state
    if (outcome === 'sent') m.sources.add(sourceId)
    if (states.includes('sent')) m.state = 'sent'
    else if (states.every((s) => s === 'refused')) {
      m.state = 'failed'
      m.failedAt = Date.now()
    } else m.state = 'pending'
    if (m.state !== before) for (const scid of send.ids) this._cacheOf(scid).version++
  }

  _sentM (send) {
    const union = this._union()
    return this._m(send.msg, union, this.core._tags(union))
  }

  /** DELETE /local/chat/<cid>/messages/<id>: own messages only, gone here at once. */
  async remove (cid, id) {
    const profile = this._profile()
    if (profile === null || !this.supported()) throw notFound()
    if (!HEX32_RE.test(id)) throw notFound()
    const union = this._union()
    const view = this._viewOf(cid, union)
    if (view === null) throw notFound()
    const m = this._messagesOf(view).find((x) => x.id === id)
    if (m !== undefined && m.from !== profile.id) throw new HttpError(403, 'Non consentito', 'refused')
    // Gone here at once; a copy that never left simply does not go (_applyDelete).
    this._applyDelete(id)
    const send = this._sends.get(id)
    const work = []
    for (let i = 0; i < view.sources.length; i++) {
      const rt = this.core._sources.get(view.sources[i])
      if (rt === undefined || rt.removing !== null || rt.closed) continue
      if (send !== undefined && send.targets.get(rt.id) === 'refused') continue
      const entry = { source: rt.id, cid: view.sourceIds[i], op: 'delete', body: { id }, at: Date.now() }
      if (!rt.link.status.connected || this._outbox.some((e) => e.source === rt.id)) {
        this._queue(entry)
        continue
      }
      work.push(this._ask(rt, 'DELETE', pathOf(entry)).then((res) => {
        if (res.status >= 500 || res.status === 429) this._queue(entry)
        else if (res.status !== 200 && res.status !== 404) this._log('chat: a deletion for ' + rt.id + ' refused (' + res.status + ')')
      }, () => this._queue(entry)))
    }
    await within(Promise.all(work), SEND_WAIT_MS)
    return [200, { ok: true }]
  }

  /** PUT /local/chat/<cid>/read { id }: the mark moves to that message when it is later. */
  async read (cid, body) {
    const profile = this._profile()
    if (profile === null || !this.supported()) throw notFound()
    if (typeof body.id !== 'string' || !HEX32_RE.test(body.id) || Object.keys(body).some((k) => k !== 'id')) throw badRequest()
    const union = this._union()
    const view = this._viewOf(cid, union)
    if (view === null) throw notFound()
    const m = this._messagesOf(view).find((x) => x.id === body.id)
    if (m === undefined) throw notFound()
    const mark = { at: m.at, id: m.id }
    if (!later(mark, this._markOf(view))) return [200, { ok: true }]
    for (const id of view.ids) this._marks.set(id, mark)
    this._viewCache.delete(view.id)
    for (let i = 0; i < view.sources.length; i++) {
      const rt = this.core._sources.get(view.sources[i])
      if (rt === undefined || !rt.link.status.connected || !this.core._live(rt)) continue
      // A source still without this conversation gets it at a later list.
      const src = this._srcOf(rt)
      const list = this._listOf(src)
      const c = list !== null ? list.convs.get(view.sourceIds[i]) : undefined
      if (c === undefined) continue
      c.markSent = true
      this._ask(rt, 'PUT', '/api/chat/' + view.sourceIds[i] + '/read', mark).then((res) => {
        if (res.status !== 200) c.markSent = false
      }, () => { c.markSent = false })
    }
    return [200, { ok: true }]
  }

  /**
   * The new mutes map for PUT /local/chat/<cid>/mute { mute }: every id of the
   * conversation, until 8 hours or a week from now, always (0), or none. Expired
   * entries go. null when the conversation is not known.
   */
  mutesFor (cid, body, map) {
    if (Object.keys(body).some((k) => k !== 'mute') || typeof body.mute !== 'string' || !(body.mute in MUTES)) throw badRequest()
    const view = this._viewOf(cid, this._union())
    if (view === null) throw notFound()
    const now = Date.now()
    const out = {}
    for (const [k, until] of Object.entries(map)) if (until === 0 || until > now) out[k] = until
    const span = MUTES[body.mute]
    for (const id of view.ids) {
      if (span === null) delete out[id]
      else out[id] = span === 0 ? 0 : now + span
    }
    return out
  }

  /** GET /local/chat/shared: the newest cards from others, one per thing shared. */
  async shared () {
    const profile = this._profile()
    if (profile === null || !this.supported()) return [200, this._sharedAnswer([])]
    this._askedAt = Date.now()
    await this._refresh()
    const union = this._union()
    const me = profile.id
    const best = new Map()
    for (const view of this._views(union)) {
      const mark = this._markOf(view)
      const muted = this._mutedUntil(view) !== null
      for (const m of this._messagesOf(view)) {
        if (m.t !== 'card' || m.from === me || m.state !== 'sent') continue
        const key = m.card.kind + '|' + m.card.id
        const had = best.get(key)
        if (had !== undefined && !later(m, had.m)) continue
        best.set(key, { m, view, unseen: later(m, mark), muted })
      }
    }
    const cards = [...best.values()].sort((a, b) => byTime(b.m, a.m)).slice(0, SHARED_MAX).map(({ m, view, unseen, muted }) => ({
      cid: view.id, messageId: m.id, from: m.from, at: m.at, card: m.card, note: m.text, unseen, muted
    }))
    return [200, this._sharedAnswer(cards)]
  }

  _sharedAnswer (cards) {
    return { v: sha256Hex(b4a.from(JSON.stringify(cards), 'utf8')).slice(0, 16), cards }
  }

  /**
   * GET /local/chat/<cid>/messages/<id>/playlist: the playlist a card shares, read
   * whole and as it is now from a source of the card that holds the conversation;
   * the last copy read when none answers (`live` false).
   */
  async playlist (cid, id) {
    const profile = this._profile()
    if (profile === null || !this.supported()) throw notFound()
    if (!HEX32_RE.test(id)) throw notFound()
    const union = this._union()
    const view = this._viewOf(cid, union)
    if (view === null) throw notFound()
    const m = this._messagesOf(view).find((x) => x.id === id)
    if (m === undefined || m.t !== 'card' || m.card.kind !== 'playlist') throw notFound()
    const had = this._playlists.get(id)
    for (const sid of m.card.sources) {
      const i = view.sources.indexOf(sid)
      const rt = this.core._sources.get(sid)
      if (i === -1 || rt === undefined || !rt.link.status.connected) continue
      try {
        const res = await this._ask(rt, 'GET', '/api/chat/' + view.sourceIds[i] + '/messages/' + id + '/playlist', null, { headers: had !== undefined && had.etag !== null ? { 'If-None-Match': had.etag } : {} })
        if (res.status === 304 && had !== undefined) return [200, { playlist: { ...had.playlist, live: true } }]
        const data = res.status === 200 ? parseJson(res.body) : null
        const p = data !== null ? playlistIn(data.playlist) : null
        if (p !== null) {
          this._playlists.delete(id)
          this._playlists.set(id, { etag: typeof res.headers.etag === 'string' ? res.headers.etag : null, playlist: p })
          while (this._playlists.size > PLAYLISTS_KEPT) this._playlists.delete(this._playlists.keys().next().value)
          return [200, { playlist: { ...p, live: true } }]
        }
        if (res.status === 404) {
          // Gone there (deleted, or the playlist removed): no older copy shown.
          this._playlists.delete(id)
          throw notFound()
        }
      } catch (err) {
        if (err instanceof HttpError) throw err
      }
    }
    if (had !== undefined) return [200, { playlist: { ...had.playlist, live: false } }]
    throw notFound()
  }
}

// A record as a source serves it: { id, seq, from, at, box } or a deletion.
function recordShape (r) {
  if (!plainObject(r) || typeof r.id !== 'string' || !HEX32_RE.test(r.id) || !Number.isSafeInteger(r.seq)) return false
  if (typeof r.from !== 'string' || !HEX32_RE.test(r.from) || !Number.isSafeInteger(r.at)) return false
  return r.deleted === true || typeof r.box === 'string'
}

function playlistIn (p) {
  if (!plainObject(p) || typeof p.id !== 'string' || !HEX16_RE.test(p.id) || typeof p.name !== 'string' || !Array.isArray(p.trackIds)) return null
  const trackIds = p.trackIds.filter((x) => typeof x === 'string' && HEX24_RE.test(x))
  return {
    id: p.id,
    name: p.name,
    n: trackIds.length,
    trackIds,
    cover: typeof p.cover === 'string' && HEX24_RE.test(p.cover) ? p.cover : null,
    updatedAt: Number.isSafeInteger(p.updatedAt) ? p.updatedAt : 0
  }
}

function pathOf (e) {
  if (e.op === 'post') return '/api/chat/' + e.cid + '/messages'
  if (e.op === 'delete') return '/api/chat/' + e.cid + '/messages/' + e.body.id
  return '/api/chat/' + e.cid + '/read'
}

function randomId () {
  const b = b4a.alloc(16)
  sodium.randombytes_buf(b)
  return b
}

function wholeNumber (v) {
  if (typeof v !== 'string' || !/^\d{1,6}$/.test(v)) return null
  return Number(v)
}
