// chat/<conversationId>.ndjson: the conversations of this source, as boxes this
// source cannot open. One JSON record per line, each appended with one write:
//   {"h":{"v":1,"kind":"group"}}  or  {"h":{"v":1,"kind":"direct","a":"<pid>","b":"<pid>"}}
//   {"m":{"id":"<32 hex>","seq":12,"from":"<pid>","at":<ms>,"pl":"<16 hex>","boxes":{"<pid>":"<base64>"}}}
//   {"d":{"id":"<32 hex>","seq":13}}                          a message deleted by its sender
//   {"r":{"p":"<pid>","at":<ms>,"id":"<32 hex>"}}              a read mark, for its own profile only
//   {"a":{"p":"<pid>","at":<ms>,"sig":"<128 hex>"}}            the silent entry of a group member
// - seq counts per conversation from 1, one per message and one per deletion.
// - "pl" is there only when the sender said the message shares one of its own
//   playlists of this source: its members may then read that playlist (read only)
//   while the message lives.
// - The access entry is signed by the member (its card's key) and counts as having
//   written in the group: an invisible member who holds one stays a recipient.
//
// Every file is read once at start. Memory keeps, per message, its id, seq,
// sender, time, recipients, the place of its line and the length of each box:
// the boxes stay on disk and each one is read alone, by its offset, when served.
// A last line cut by a crash is dropped and the file cut back to its last whole
// line.
//
// A message deleted for everyone leaves the disk at once: when its deletion line
// is on disk, the message's line is written over where it lies, with one write of
// the same length, so no other offset moves:
//   {"m":{"id":"<32 hex>","seq":12,"from":"<pid>","at":<ms>,"boxes":{"<pid>":""}}}<spaces>
// What stays is what its deletion needs: the id (the deletion names it), seq,
// sender and time (a deletion is served as { id, seq, from, at, deleted }) and the
// profiles it was for (it is served only to them); the boxes, the playlist it
// shared and the length of each box go. Until the next rewrite the spaces keep the
// length of the whole line, a size this source saw when the message came. A
// deletion whose message still holds its boxes at start (a crash between the two
// writes, or a version that left them there) has them written over then, in the
// background, a few lines at a time; so has, with spaces only, a message line a
// crash cut short while it was being written over.
//
// Retention: the newest 5,000 live messages and 48 MB of their lines per
// conversation, the newest 1,000 deletions; the oldest go without a word. A file
// is rewritten (temporary file, fsync, rename) with the header, each profile's
// newest read mark, the access entries, the live messages and the kept deletions
// (each with its message's blank line before it, so it is read back after a
// restart and seq never goes back), in seq order:
// - with more than twice those lines plus 1,000;
// - when the rest (trimmed or deleted messages, older read marks) weighs more than
//   a quarter of the live messages and at least 1 MB: so a conversation at its
//   limits is rewritten once its dead part grows that big, not every few messages,
//   each byte written is copied a few times at most, and the file stays within 1.25
//   times what it keeps plus 1 MB;
// - with no live message left, once the rest weighs half of what it keeps (a
//   family's chat emptied of its messages at once; one emptied again and again is
//   rewritten at most once per its own size written, never at every delete).
// Writes of one conversation run one at a time; reads never wait for them.
//
// A profile removed from the source takes its direct conversations with it, files
// included (nobody can open them any more); at start, so do those of profiles
// removed before. In the group its messages stay.
//
// Long poll: waitFor(pid, ms) resolves at the next change that may touch what
// that profile is served (a message, a deletion or a read mark of one of its
// conversations, a direct conversation gone, a block or a privacy change of
// anyone), or after ms.

import fs from 'node:fs'
import path from 'node:path'
import sodium from 'sodium-native'
import { apiError } from './errors.mjs'
import { isProfileId, isPlaylistId } from './ids.mjs'
import { ensureDir, renameSyncRetry, fsyncDirSync, isBusy, logError } from './util.mjs'

export const MAX_LIVE = 5000
export const MAX_LIVE_BYTES = 48 * 1024 * 1024
export const MAX_DELETIONS = 1000
// The body of a POST: this much plus this much per recipient of the conversation.
export const BODY_BASE = 4 * 1024
export const BODY_PER_RECIPIENT = 16896
export const MAX_PLAINTEXT = 12288
// A box: nonce 24, MAC 16, plaintext 1 to 12,288 bytes.
export const MIN_BOX_BYTES = 41
export const MAX_BOX_BYTES = 24 + 16 + MAX_PLAINTEXT
export const MAX_UNREAD = 999
export const PAGE = 100
export const MAX_PAGE = 200
// A message time may be this far ahead of this source's clock, or this far behind.
export const AHEAD_MS = 5 * 60 * 1000
export const BEHIND_MS = 30 * 24 * 3600 * 1000
// The longest a request waits for a change; the most waits one profile holds.
export const MAX_WAIT_MS = 25000
const MAX_WAITERS = 8
// The least weight of lines no longer served that is worth a rewrite.
const DEAD_MIN = 1024 * 1024
// Box reads: one read of the whole span when it is this small, else one per box.
const SPAN_READ = 256 * 1024
// Deleted messages found with their boxes at start: written over this many lines,
// or about this many bytes, per turn of their conversation's queue.
export const HEAL_LINES = 64
const HEAL_BYTES = 1024 * 1024
const FILE_RE = /^([0-9a-f]{32})\.ndjson$/
const HEX32_RE = /^[0-9a-f]{32}$/
const SIG_RE = /^[0-9a-f]{128}$/
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const TAG_DIRECT = Buffer.from('mpfy/chat-direct/1')
const TAG_GROUP = Buffer.from('mpfy/chat-group/1')
const TAG_ACCESS = Buffer.from('mpfy/chat-access/1')
const BOXES_KEY = Buffer.from(',"boxes":{', 'latin1')
const QUOTE = 0x22

function blake (...parts) {
  const out = Buffer.alloc(32)
  sodium.crypto_generichash(out, Buffer.concat(parts))
  return out
}

/** The direct conversation of two profiles, the same from both sides. */
export function directIdOf (a, b) {
  const [lo, hi] = a < b ? [a, b] : [b, a]
  return blake(TAG_DIRECT, Buffer.from(lo, 'hex'), Buffer.from(hi, 'hex')).subarray(0, 16).toString('hex')
}

/** The group of a source, from its main public key (64 hex). */
export function groupIdOf (serverPublicKey) {
  return blake(TAG_GROUP, Buffer.from(serverPublicKey, 'hex')).subarray(0, 16).toString('hex')
}

/** The bytes a member's access entry signs. */
export function accessBytes (profileId, groupId, at) {
  return Buffer.concat([TAG_ACCESS, Buffer.from(JSON.stringify([1, profileId, groupId, at]), 'utf8')])
}

function plainObject (v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

// The decoded size of a padded base64 string.
function base64Bytes (s) {
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0
  return (s.length / 4) * 3 - pad
}

function validBox (box) {
  if (typeof box !== 'string') return false
  // The length first: the regex never runs over a string far too long.
  if (box.length < 56 || box.length > Math.ceil(MAX_BOX_BYTES / 3) * 4 || !BASE64_RE.test(box)) return false
  const n = base64Bytes(box)
  return n >= MIN_BOX_BYTES && n <= MAX_BOX_BYTES
}

// (at, id) after (at, id): the later one.
function later (a, b) {
  return b === null || a.at > b.at || (a.at === b.at && a.id > b.id)
}

// A message line, exactly as it is written (every value is ASCII: hex, digits, base64).
function messageLine (e, boxes) {
  let s = '{"m":{"id":"' + e.id + '","seq":' + e.seq + ',"from":"' + e.from + '","at":' + e.at
  if (e.pl !== null) s += ',"pl":"' + e.pl + '"'
  s += ',"boxes":{'
  for (let i = 0; i < e.to.length; i++) s += (i > 0 ? ',"' : '"') + e.to[i] + '":"' + boxes[i] + '"'
  return s + '}}}\n'
}

// What stays of a deleted message (without its line end): its envelope without the
// playlist, and the profiles it was for, each with an empty box.
function blankRecord (e) {
  let s = '{"m":{"id":"' + e.id + '","seq":' + e.seq + ',"from":"' + e.from + '","at":' + e.at + ',"boxes":{'
  for (let i = 0; i < e.to.length; i++) s += (i > 0 ? ',"' : '"') + e.to[i] + '":""'
  return s + '}}}'
}

const deletionLine = (id, seq) => '{"d":{"id":"' + id + '","seq":' + seq + '}}\n'
const readLine = (p, r) => '{"r":{"p":"' + p + '","at":' + r.at + ',"id":"' + r.id + '"}}\n'
const accessLine = (p, a) => '{"a":{"p":"' + p + '","at":' + a.at + ',"sig":"' + a.sig + '"}}\n'

function headerLine (conv) {
  return conv.kind === 'group'
    ? '{"h":{"v":1,"kind":"group"}}\n'
    : '{"h":{"v":1,"kind":"direct","a":"' + conv.a + '","b":"' + conv.b + '"}}\n'
}

// The offset of box k inside its line: each entry is "<pid>":"<box>", and a comma.
function boxOffset (e, k) {
  let at = e.boff
  for (let j = 0; j < k; j++) at += 38 + e.lens[j]
  return at + 36
}

/**
 * A message line read from the file, its envelope and where each box sits:
 * { id, seq, from, at, pl, to, lens, boff } or null when the line is not one this
 * store wrote (it is then read whole, with JSON).
 */
function scanMessage (line) {
  const idx = line.indexOf(BOXES_KEY)
  if (idx === -1) return null
  let env = null
  try {
    env = JSON.parse(line.toString('latin1', 0, idx) + '}}')
  } catch {
    return null
  }
  const m = plainObject(env) ? env.m : null
  if (!plainObject(m)) return null
  const to = []
  const lens = []
  const boff = idx + BOXES_KEY.length
  let pos = boff
  for (;;) {
    if (line[pos] !== QUOTE || line[pos + 33] !== QUOTE || line[pos + 34] !== 0x3a || line[pos + 35] !== QUOTE) return null
    const pid = line.toString('latin1', pos + 1, pos + 33)
    if (!HEX32_RE.test(pid)) return null
    const start = pos + 36
    const end = line.indexOf(QUOTE, start)
    if (end === -1) return null
    to.push(pid)
    lens.push(end - start)
    const next = line[end + 1]
    if (next === 0x2c) {
      pos = end + 2
      continue
    }
    if (next === 0x7d && end + 4 === line.length && line[end + 2] === 0x7d && line[end + 3] === 0x7d) break
    return null
  }
  return { id: m.id, seq: m.seq, from: m.from, at: m.at, pl: m.pl === undefined ? null : m.pl, to, lens, boff }
}

export class ChatStore {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir
   * @param {string} opts.groupId  this source's group (groupIdOf of its main key)
   * @param {() => number} [opts.now]  this source's clock (the social part's)
   * @param {boolean} [opts.sync=true]  flush each message to disk before answering (tests turn it off)
   * @param {(pid: string) => boolean} [opts.isRemoved]  a profile removed from the source
   */
  constructor ({ dataDir, groupId, now = Date.now, sync = true, isRemoved = () => false }) {
    this.dir = path.join(path.resolve(dataDir), 'chat')
    this.groupId = groupId
    this.now = now
    this.sync = sync
    this.isRemoved = isRemoved
    this._convs = new Map() // cid -> conversation
    this._directOf = new Map() // pid -> Set of direct cids it is a party of
    this._strings = new Map() // one copy of each profile id in memory
    this._lists = new Map() // one copy of each list of recipients (they repeat message after message)
    this._waiters = new Map() // pid -> Set of waits
    this._aside = new Set() // work beside the queues: blanking at start, files of conversations gone
    this._closed = false
    /** How many times a file was rewritten whole (tests). */
    this.compactions = 0
  }

  /** Whether close() was called. */
  get closed () {
    return this._closed
  }

  _intern (s) {
    const had = this._strings.get(s)
    if (had !== undefined) return had
    this._strings.set(s, s)
    return s
  }

  // ------------------------------------------------------------------ load

  /** Read every file once. A file whose header does not parse is set aside. */
  async load () {
    ensureDir(this.dir)
    let names = []
    try {
      names = fs.readdirSync(this.dir)
    } catch (err) {
      logError('chat folder not readable (' + err.message + ')')
      return
    }
    for (const name of names) {
      const m = FILE_RE.exec(name)
      if (m === null) {
        // A rewrite cut by a crash: the file it was made from is whole.
        if (name.endsWith('.ndjson.tmp')) try { fs.unlinkSync(path.join(this.dir, name)) } catch {}
        continue
      }
      try {
        await this._loadFile(m[1], path.join(this.dir, name))
      } catch (err) {
        logError('chat file ' + name + ' not read (' + err.message + ')')
      }
    }
  }

  async _loadFile (cid, file) {
    let buf = await fs.promises.readFile(file)
    // A last line cut by a crash is dropped.
    const lastNl = buf.lastIndexOf(0x0a)
    if (lastNl !== buf.length - 1) {
      fs.truncateSync(file, lastNl + 1)
      buf = buf.subarray(0, lastNl + 1)
      logError('chat file ' + cid + ': a cut last line was dropped')
    }
    let conv = null
    let pos = 0
    let lines = 0
    const heal = [] // deleted messages whose lines still hold their boxes, lines cut short
    while (pos < buf.length) {
      const nl = buf.indexOf(0x0a, pos)
      const line = buf.subarray(pos, nl)
      const off = pos
      pos = nl + 1
      lines++
      if (conv === null) {
        conv = this._fromHeader(cid, file, line)
        if (conv === null) break
        continue
      }
      this._replay(conv, line, off, heal)
    }
    if (conv === null) {
      const aside = file + '.corrupt-' + Date.now()
      try {
        renameSyncRetry(file, aside)
      } catch {}
      logError('chat file ' + cid + ': no header, set aside as ' + path.basename(aside))
      return
    }
    conv.lines = lines
    conv.bytes = buf.length
    this._convs.set(cid, conv)
    if (conv.kind === 'direct') this._indexDirect(conv)
    this._retain(conv)
    if (this._needsCompaction(conv)) this._queue(conv, () => this._compact(conv)).catch(() => {})
    if (heal.length > 0) this._healLater(conv, heal)
  }

  _fromHeader (cid, file, line) {
    let h = null
    try {
      h = JSON.parse(line.toString('utf8')).h
    } catch {
      return null
    }
    if (!plainObject(h) || h.v !== 1) return null
    if (h.kind === 'group') return cid === this.groupId ? this._newConv(cid, 'group', null, null, file) : null
    if (h.kind !== 'direct' || !isProfileId(h.a) || !isProfileId(h.b) || !(h.a < h.b) || directIdOf(h.a, h.b) !== cid) return null
    return this._newConv(cid, 'direct', h.a, h.b, file)
  }

  _newConv (cid, kind, a, b, file) {
    return {
      id: cid,
      kind,
      a: a === null ? null : this._intern(a),
      b: b === null ? null : this._intern(b),
      file,
      exists: true, // the file is there
      dropped: false, // gone whole (a party removed): nothing is written to it again
      entries: [], // live messages and kept deletions, in seq order
      byId: new Map(), // message id -> its live message or its kept deletion
      seq: 0,
      live: 0,
      liveBytes: 0,
      deletions: 0,
      delBytes: 0, // what the kept deletions weigh in a rewrite, each with its blank message
      liveBy: new Map(), // sender -> live messages
      toCount: new Map(), // profile -> records addressed to it
      reads: new Map(), // profile -> { at, id }
      access: new Map(), // profile -> { at, sig } (the group)
      lines: 0,
      bytes: 0,
      version: 0,
      shape: 0, // moves when records go (a deletion, a trim): appending alone keeps it
      gen: 0, // moves when the file is rewritten (offsets change)
      chain: Promise.resolve(),
      cache: new Map() // profile -> { key, summary }
    }
  }

  _indexDirect (conv) {
    for (const p of [conv.a, conv.b]) {
      let set = this._directOf.get(p)
      if (set === undefined) {
        set = new Set()
        this._directOf.set(p, set)
      }
      set.add(conv.id)
    }
  }

  // One line of a file read at start. `heal` collects the deleted messages whose
  // lines still hold their boxes, and the message lines cut short.
  _replay (conv, line, off, heal) {
    // A message line as this store writes it: its envelope parsed, its boxes only measured.
    const e = line.subarray(0, 6).toString('latin1') === '{"m":{' ? scanMessage(line) : null
    if (e !== null) {
      this._replayMessage(conv, e, false, off, line.length + 1, e.pl === null && e.lens.every((n) => n === 0))
      return
    }
    let rec = null
    try {
      rec = JSON.parse(line.toString('utf8'))
    } catch {
      // A message line cut short by a crash while it was written over (a write of a
      // big line can stop part way): never served, and what is left of its boxes is
      // written over too, with spaces only.
      if (line.subarray(0, 6).toString('latin1') === '{"m":{') heal.push({ off, len: line.length + 1, blank: false, wipe: true })
      return
    }
    if (!plainObject(rec)) return
    if (plainObject(rec.m)) {
      // Not a line this store wrote (or a deleted one, its spaces after it): read
      // whole again whenever it is served.
      const m = rec.m
      if (!plainObject(m.boxes)) return
      const blank = m.pl === undefined && Object.values(m.boxes).every((x) => x === '')
      this._replayMessage(conv, { id: m.id, seq: m.seq, from: m.from, at: m.at, pl: m.pl === undefined ? null : m.pl, to: Object.keys(m.boxes), lens: null, boff: 0 }, true, off, line.length + 1, blank)
    } else if (plainObject(rec.d)) {
      const { id, seq } = rec.d
      if (!Number.isSafeInteger(seq) || seq <= conv.seq) return
      const entry = conv.byId.get(id)
      // Its message left out by a rewrite of an earlier version: nothing to serve,
      // but its seq stays taken (seq never goes back for a core that holds one).
      if (entry === undefined || entry.k !== 'm') {
        conv.seq = seq
        return
      }
      this._delete(conv, entry, seq)
      if (!entry.blank) heal.push(entry)
    } else if (plainObject(rec.r)) {
      const { p, at, id } = rec.r
      if (isProfileId(p) && Number.isSafeInteger(at) && HEX32_RE.test(id)) {
        const had = conv.reads.get(p) || null
        if (later({ at, id }, had)) conv.reads.set(this._intern(p), { at, id })
      }
    } else if (plainObject(rec.a) && conv.kind === 'group') {
      const { p, at, sig } = rec.a
      if (isProfileId(p) && Number.isSafeInteger(at) && typeof sig === 'string' && SIG_RE.test(sig)) {
        const had = conv.access.get(p)
        if (had === undefined || at > had.at) conv.access.set(this._intern(p), { at, sig })
      }
    }
  }

  // A list of recipients, shared by every message that has the same one (never changed).
  _internList (to) {
    const key = to.join(',')
    let list = this._lists.get(key)
    if (list === undefined) {
      list = Object.freeze(to.map((p) => this._intern(p)))
      this._lists.set(key, list)
    }
    return list
  }

  _replayMessage (conv, e, raw, off, len, blank) {
    if (typeof e.id !== 'string' || !HEX32_RE.test(e.id) || !isProfileId(e.from) || !Number.isSafeInteger(e.seq) || e.seq <= conv.seq || !Number.isSafeInteger(e.at)) return
    if (e.pl !== null && !isPlaylistId(e.pl)) e.pl = null
    if (conv.byId.has(e.id) || !e.to.includes(e.from) || !e.to.every(isProfileId)) return
    const entry = this._message(e.id, e.seq, e.from, e.at, e.pl, e.to, e.lens, e.boff, off, len)
    entry.raw = raw
    entry.blank = blank
    this._addMessage(conv, entry)
  }

  _message (id, seq, from, at, pl, to, lens, boff, off, len) {
    // `lens` copied to its exact size: an array grown by push keeps spare room.
    // `blank`: its line holds no box any more (a deleted message).
    return { k: 'm', id, seq, from: this._intern(from), at, pl, to: this._internList(to), lens: lens === null ? null : lens.slice(), boff, off, len, raw: false, gone: false, blank: false }
  }

  // ---------------------------------------------------------- bookkeeping

  _count (map, key, n) {
    const v = (map.get(key) || 0) + n
    if (v > 0) map.set(key, v)
    else map.delete(key)
  }

  _addMessage (conv, e) {
    conv.entries.push(e)
    conv.byId.set(e.id, e)
    conv.seq = e.seq
    conv.live++
    conv.liveBytes += e.len
    this._count(conv.liveBy, e.from, 1)
    for (const p of e.to) this._count(conv.toCount, p, 1)
    conv.version++
  }

  _delete (conv, e, seq) {
    const i = this._indexOf(conv, e.seq)
    if (i !== -1) conv.entries.splice(i, 1)
    // Its boxes are never served again (and are written over on disk: _blank).
    e.gone = true
    const d = { k: 'd', id: e.id, seq, msg: e, size: blankRecord(e).length + 1 + deletionLine(e.id, seq).length }
    conv.entries.push(d)
    conv.byId.set(e.id, d)
    conv.seq = seq
    conv.live--
    conv.liveBytes -= e.len
    conv.deletions++
    conv.delBytes += d.size
    this._count(conv.liveBy, e.from, -1)
    conv.version++
    conv.shape++
    // The oldest deletions go: their ids are unknown here afterwards.
    while (conv.deletions > MAX_DELETIONS) {
      const j = conv.entries.findIndex((x) => x.k === 'd')
      const old = conv.entries[j]
      conv.entries.splice(j, 1)
      conv.byId.delete(old.id)
      conv.deletions--
      conv.delBytes -= old.size
      for (const p of old.msg.to) this._count(conv.toCount, p, -1)
    }
  }

  // The position of the entry of `seq` (binary search), or -1.
  _indexOf (conv, seq) {
    const list = conv.entries
    let lo = 0
    let hi = list.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const s = list[mid].seq
      if (s === seq) return mid
      if (s < seq) lo = mid + 1
      else hi = mid - 1
    }
    return -1
  }

  // The first position whose seq is above `seq`.
  _firstAbove (conv, seq) {
    const list = conv.entries
    let lo = 0
    let hi = list.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (list[mid].seq <= seq) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  // The newest 5,000 live messages and 48 MB of them; the oldest go.
  _retain (conv) {
    let n = 0
    while ((conv.live > MAX_LIVE || conv.liveBytes > MAX_LIVE_BYTES) && conv.live > 1) {
      const i = conv.entries.findIndex((x) => x.k === 'm')
      const e = conv.entries[i]
      conv.entries.splice(i, 1)
      conv.byId.delete(e.id)
      e.gone = true
      conv.live--
      conv.liveBytes -= e.len
      this._count(conv.liveBy, e.from, -1)
      for (const p of e.to) this._count(conv.toCount, p, -1)
      n++
    }
    if (n > 0) {
      conv.version++
      conv.shape++
    }
    return n
  }

  // The lines a rewrite writes (a kept deletion is two: its blank message and itself).
  _liveLines (conv) {
    return 1 + conv.reads.size + conv.access.size + conv.live + 2 * conv.deletions
  }

  // The bytes a rewrite writes: the header, the newest read mark of each profile, the
  // access entries, the live messages and the kept deletions.
  _keptBytes (conv) {
    let n = headerLine(conv).length + conv.liveBytes + conv.delBytes
    for (const [p, r] of conv.reads) n += readLine(p, r).length
    for (const [p, a] of conv.access) n += accessLine(p, a).length
    return n
  }

  _needsCompaction (conv) {
    if (!conv.exists || conv.dropped) return false
    if (conv.lines > 2 * this._liveLines(conv) + 1000) return true
    const kept = this._keptBytes(conv)
    const dead = conv.bytes - kept
    if (dead > Math.max(conv.liveBytes / 4, DEAD_MIN)) return true
    // No live message left: cut down to what it keeps once the rest weighs half of
    // that, so a rewrite never writes more than twice what it takes away.
    return conv.live === 0 && dead > 0 && 2 * dead >= kept
  }

  // One change of a conversation's file at a time.
  _queue (conv, fn) {
    const run = conv.chain.then(fn)
    conv.chain = run.then(() => {}, () => {})
    return run
  }

  _conv (cid) {
    return this._convs.get(cid) || null
  }

  _ensureConv (cid, kind, a, b) {
    let conv = this._convs.get(cid)
    if (conv === undefined) {
      conv = this._newConv(cid, kind, a, b, path.join(this.dir, cid + '.ndjson'))
      conv.exists = false
      this._convs.set(cid, conv)
      if (kind === 'direct') this._indexDirect(conv)
    }
    return conv
  }

  // Append `text` (whole lines) to the file, creating it with its header first.
  // A write that fails leaves the file as it was.
  async _append (conv, text, durable) {
    if (this._closed) throw new Error('chat store closed')
    // A conversation gone whole (a party removed) is never written again.
    if (conv.dropped) throw apiError('message_gone')
    let data = Buffer.from(text, 'latin1')
    let header = 0
    if (!conv.exists) {
      ensureDir(this.dir)
      const h = Buffer.from(headerLine(conv), 'latin1')
      header = h.length
      data = Buffer.concat([h, data])
    }
    const start = conv.exists ? conv.bytes : 0
    const fh = await fs.promises.open(conv.file, conv.exists ? 'a' : 'w', 0o600)
    try {
      await fh.write(data, 0, data.length)
      if (durable && this.sync) await fh.sync()
    } catch (err) {
      try {
        await fh.truncate(start)
      } catch {}
      throw err
    } finally {
      await fh.close()
    }
    if (!conv.exists) {
      conv.exists = true
      conv.lines = 1
      fsyncDirSync(this.dir)
    }
    conv.bytes = start + data.length
    return start + header
  }

  // ------------------------------------------------------------- compaction

  async _compact (conv) {
    if (this._closed || !conv.exists || conv.dropped) return
    // Each kept deletion comes with its message's blank line before it, at that
    // message's place in seq order: so the deletion is read back after a restart
    // (served as before, and seq never goes back for a core that holds a seq).
    const blanks = []
    for (const e of conv.entries) if (e.k === 'd') blanks.push(e.msg)
    blanks.sort((x, y) => x.seq - y.seq)
    let next = 0
    const tmp = conv.file + '.tmp'
    const out = await fs.promises.open(tmp, 'w', 0o600)
    const src = await fs.promises.open(conv.file, 'r')
    const placed = new Map() // entry -> its new offset
    let size = 0
    let lines = 0
    const pending = []
    let pendingBytes = 0
    const flush = async () => {
      if (pending.length === 0) return
      const chunk = Buffer.concat(pending)
      pending.length = 0
      pendingBytes = 0
      await out.write(chunk, 0, chunk.length)
    }
    const put = async (buf) => {
      pending.push(buf)
      pendingBytes += buf.length
      size += buf.length
      lines++
      if (pendingBytes >= 1024 * 1024) await flush()
    }
    try {
      await put(Buffer.from(headerLine(conv), 'latin1'))
      for (const [p, r] of conv.reads) await put(Buffer.from(readLine(p, r), 'latin1'))
      for (const [p, a] of conv.access) await put(Buffer.from(accessLine(p, a), 'latin1'))
      for (const e of conv.entries) {
        while (next < blanks.length && blanks[next].seq < e.seq) await put(Buffer.from(blankRecord(blanks[next++]) + '\n', 'latin1'))
        if (e.k === 'm') {
          const buf = Buffer.alloc(e.len)
          await src.read(buf, 0, e.len, e.off)
          placed.set(e, size)
          await put(buf)
        } else {
          await put(Buffer.from(deletionLine(e.id, e.seq), 'latin1'))
        }
      }
      await flush()
      await out.sync()
    } catch (err) {
      await out.close().catch(() => {})
      await src.close().catch(() => {})
      try { fs.unlinkSync(tmp) } catch {}
      logError('chat file ' + conv.id + ' not rewritten (' + err.message + ')')
      return
    }
    await out.close()
    await src.close()
    if (this._closed) {
      try { fs.unlinkSync(tmp) } catch {}
      return
    }
    // The rename and the new offsets together, with nothing in between: a read
    // that opened the old file sees `gen` moved and starts again.
    renameSyncRetry(tmp, conv.file)
    for (const [e, off] of placed) e.off = off
    for (const m of blanks) m.blank = true
    conv.gen++
    conv.lines = lines
    conv.bytes = size
    this.compactions++
    fsyncDirSync(this.dir)
  }

  _afterWrite (conv) {
    if (this._needsCompaction(conv)) return this._compact(conv)
  }

  // ------------------------------------------------------------- blanking

  /**
   * Deleted messages written over where they lie: each line becomes blankRecord and
   * spaces up to its old length, one positional write, so every other offset stays
   * right. Runs in the conversation's queue (never beside an append or a rewrite).
   */
  async _blank (conv, list) {
    if (conv.dropped || !conv.exists) return
    let misfit = false
    const fh = await fs.promises.open(conv.file, 'r+')
    try {
      for (const e of list) {
        if (e.blank) continue
        // A line cut short (`wipe`) keeps nothing at all.
        const text = e.wipe ? '' : blankRecord(e)
        if (text.length > e.len - 1) {
          misfit = true
          continue
        }
        const buf = Buffer.alloc(e.len - 1, 0x20)
        buf.write(text, 0, 'latin1')
        await fh.write(buf, 0, buf.length, e.off)
        e.blank = true
      }
      if (this.sync) await fh.sync()
    } finally {
      await fh.close()
    }
    // A line written another way, too short for its blank: the file is rewritten
    // without it.
    if (misfit) await this._compact(conv)
  }

  /**
   * The deleted messages found at start with their boxes still on disk (and the lines
   * cut short), written over in the background: HEAL_LINES lines (or about 1 MB) per turn of the
   * conversation's queue, the event loop free in between, so nothing waits in
   * proportion to the file. A rewrite meanwhile has left them out already.
   */
  _healLater (conv, list) {
    const gen = conv.gen
    let i = 0
    const step = () => this._queue(conv, async () => {
      if (this._closed || conv.dropped || conv.gen !== gen) return false
      const batch = []
      let bytes = 0
      while (i < list.length && batch.length < HEAL_LINES && bytes < HEAL_BYTES) {
        const e = list[i++]
        if (e.blank) continue
        batch.push(e)
        bytes += e.len
      }
      if (batch.length > 0) await this._blank(conv, batch)
      return i < list.length
    })
    const turn = () => new Promise((resolve) => setImmediate(resolve))
    const run = (async () => {
      // After the start's own steps (the removals of people.startup()).
      await turn()
      while (await step()) await turn()
    })().catch((err) => logError('chat file ' + conv.id + ': deleted messages not blanked yet (' + err.message + ')'))
    this._track(run)
  }

  _track (p) {
    this._aside.add(p)
    p.then(() => this._aside.delete(p))
  }

  // A conversation goes whole: out of memory now (and its people's waits end, as at
  // a deletion: their lists lose it), its file after what its queue already holds
  // (refused from now on: nothing is written to it again).
  _drop (conv) {
    conv.dropped = true
    conv.gen++
    this._convs.delete(conv.id)
    for (const p of [conv.a, conv.b]) {
      const set = this._directOf.get(p)
      if (set === undefined) continue
      set.delete(conv.id)
      if (set.size === 0) this._directOf.delete(p)
    }
    this._notifyConv(conv)
    const run = this._queue(conv, async () => {
      if (!conv.exists) return
      for (let attempt = 0; ; attempt++) {
        try {
          await fs.promises.unlink(conv.file)
          break
        } catch (err) {
          if (err.code === 'ENOENT') break
          if (attempt >= 6 || !isBusy(err)) throw err
          await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)))
        }
      }
      conv.exists = false
      fsyncDirSync(this.dir)
    }).catch((err) => logError('chat file ' + conv.id + ' not removed (' + err.message + '), again at the next start'))
    this._track(run)
    return run
  }

  // ------------------------------------------------------------- reading

  /**
   * The boxes of `list` (live message entries of `conv`) for `pid`, as strings by
   * message id. One read for a small span, else one read per box.
   */
  async readBoxes (conv, list, pid) {
    const out = new Map()
    for (let attempt = 0; attempt < 4; attempt++) {
      // A conversation gone whole has nothing to serve.
      if (conv.dropped) return out
      // A message trimmed or deleted meanwhile is not read (after a rewrite its
      // place is no longer its own).
      const want = list.filter((e) => e.k === 'm' && !e.gone && e.to.includes(pid))
      if (want.length === 0) return out
      const gen = conv.gen
      // The places before the file is opened: a rewrite in between moves gen.
      const spots = want.map((e) => ({ e, off: e.off, len: e.len, raw: e.raw, k: e.to.indexOf(pid) }))
      let fh = null
      try {
        fh = await fs.promises.open(conv.file, 'r')
      } catch (err) {
        if (err.code === 'ENOENT' && conv.gen !== gen) continue
        throw err
      }
      try {
        if (conv.gen !== gen) continue
        const first = spots[0].off
        const last = spots[spots.length - 1]
        const span = last.off + last.len - first
        let whole = null
        if (span <= SPAN_READ) {
          whole = Buffer.alloc(span)
          await fh.read(whole, 0, span, first)
        }
        // A message deleted while this read ran is left out: what was read of it may
        // be its blank line already (it is marked gone before that is written).
        for (const s of spots) {
          if (s.raw) {
            const line = whole !== null ? whole.subarray(s.off - first, s.off - first + s.len) : await readAt(fh, s.off, s.len)
            if (s.e.gone) continue
            const m = JSON.parse(line.toString('utf8')).m
            out.set(s.e.id, m.boxes[pid])
            continue
          }
          const at = boxOffset(s.e, s.k)
          const n = s.e.lens[s.k]
          const bytes = whole !== null ? whole.subarray(s.off - first + at, s.off - first + at + n) : await readAt(fh, s.off + at, n)
          if (s.e.gone) continue
          out.set(s.e.id, bytes.toString('latin1'))
        }
        return out
      } finally {
        await fh.close()
      }
    }
    throw new Error('chat file rewritten during every read')
  }

  // ------------------------------------------------------------- people

  /** Whether `pid` counts as written in this source's group (a live message or its access entry). */
  inGroup (pid) {
    const g = this._convs.get(this.groupId)
    return g !== undefined && ((g.liveBy.get(pid) || 0) > 0 || g.access.has(pid))
  }

  /** Whether `pid` has a live message in its direct conversation with `other`, or counts as written in the group. */
  chatSeen (pid, other) {
    if (this.inGroup(pid)) return true
    const d = this._convs.get(directIdOf(pid, other))
    return d !== undefined && (d.liveBy.get(pid) || 0) > 0
  }

  /** The access entry of `pid` in the group: its time, 0 when none. */
  accessAt (pid) {
    const g = this._convs.get(this.groupId)
    const a = g !== undefined ? g.access.get(pid) : undefined
    return a !== undefined ? a.at : 0
  }

  /**
   * A profile leaves the source. Its direct conversations go whole, files included
   * (nobody can open them any more), and leave the other person's list at once, as
   * a deleted message does. In the group its read mark and access entry go, its
   * messages stay. Resolves when those files are gone. Called again at every start
   * for each profile removed: a file left from before goes then.
   */
  removeProfile (pid) {
    const gone = []
    for (const cid of [...(this._directOf.get(pid) || [])]) {
      const conv = this._convs.get(cid)
      if (conv !== undefined) gone.push(this._drop(conv))
    }
    let any = false
    for (const conv of this._convs.values()) {
      const read = conv.reads.delete(pid)
      const access = conv.access.delete(pid)
      if (read || access) {
        conv.version++
        any = true
      }
    }
    if (any) this.notify(null)
    return Promise.all(gone).then(() => {})
  }

  // --------------------------------------------------------------- waits

  /**
   * Resolves at the next change that may touch what `pid` is served ('change'),
   * after `ms` ('timeout'), when the store closes ('closed'), or when the profile
   * already holds too many waits and this is the oldest ('evicted': its request
   * answers now, it never waits again).
   */
  waitFor (pid, ms) {
    return new Promise((resolve) => {
      if (this._closed) return resolve('closed')
      let set = this._waiters.get(pid)
      if (set === undefined) {
        set = new Set()
        this._waiters.set(pid, set)
      }
      const w = { done: null, timer: null }
      const done = (why) => {
        if (w.done === null) return
        w.done = null
        clearTimeout(w.timer)
        set.delete(w)
        if (set.size === 0 && this._waiters.get(pid) === set) this._waiters.delete(pid)
        resolve(why)
      }
      w.done = done
      w.timer = setTimeout(() => done('timeout'), Math.max(0, ms))
      if (set.size >= MAX_WAITERS) set.values().next().value.done('evicted')
      set.add(w)
    })
  }

  /** Wake the waits of these profiles (null: everyone's). */
  notify (pids) {
    const sets = pids === null ? [...this._waiters.values()] : pids.map((p) => this._waiters.get(p)).filter((s) => s !== undefined)
    const why = this._closed ? 'closed' : 'change'
    for (const set of sets) for (const w of [...set]) w.done(why)
  }

  _notifyConv (conv) {
    if (conv.kind === 'direct') this.notify([conv.a, conv.b])
    else this.notify(null)
  }

  // ----------------------------------------------------------- what is served

  /**
   * What `pid` may see of a conversation: the newest record it may see (seq), its
   * newest live message (last), its unread count and its read mark. `hidden(from)`
   * says whose records it does not see (the people it blocked); `stamp` names the
   * state of `hidden` (it is cached with it).
   */
  summary (conv, pid, hidden, stamp) {
    const mark = conv.reads.get(pid) || null
    const markKey = mark === null ? '' : mark.at + '|' + mark.id
    const c = conv.cache.get(pid)
    if (c !== undefined && c.shape === conv.shape && c.stamp === stamp && c.markKey === markKey) {
      if (c.upto === conv.seq) return c.summary
      // Only messages were appended since: counted from where it stopped, not again
      // from the start (a new message costs each member one step, not a whole scan).
      const add = this._scan(conv, pid, hidden, mark, c.upto)
      const s = c.summary
      const summary = {
        seq: add.seq || s.seq,
        last: add.last || s.last,
        unread: Math.min(MAX_UNREAD, s.unread + add.unread),
        read: s.read
      }
      conv.cache.set(pid, { shape: conv.shape, stamp, markKey, upto: conv.seq, summary })
      return summary
    }
    const all = this._scan(conv, pid, hidden, mark, 0)
    const summary = { seq: all.seq, last: all.last, unread: all.unread, read: mark === null ? null : { at: mark.at, id: mark.id } }
    conv.cache.set(pid, { shape: conv.shape, stamp, markKey, upto: conv.seq, summary })
    return summary
  }

  // The records above `from` that `pid` sees, newest first: the newest seq, the
  // newest live message, the unread ones (at most 999).
  _scan (conv, pid, hidden, mark, from) {
    let seq = 0
    let last = null
    let unread = 0
    for (let i = conv.entries.length - 1; i >= 0; i--) {
      const e = conv.entries[i]
      if (e.seq <= from) break
      const m = e.k === 'm' ? e : e.msg
      if (!m.to.includes(pid)) continue
      if (m.from !== pid && hidden(m.from)) continue
      if (seq === 0) seq = e.seq
      if (e.k !== 'm') continue
      if (last === null) last = e
      if (m.from !== pid && unread < MAX_UNREAD && later(m, mark)) unread++
    }
    return { seq, last, unread }
  }

  /**
   * The conversations `pid` is in: the group always (null when it has no file
   * yet), and every direct one where a record is addressed to it, except those
   * with someone it blocked.
   */
  conversationsOf (pid, hidden) {
    const out = [{ id: this.groupId, kind: 'group', conv: this._convs.get(this.groupId) || null }]
    for (const cid of this._directOf.get(pid) || []) {
      const conv = this._convs.get(cid)
      if (conv === undefined || (conv.toCount.get(pid) || 0) === 0) continue
      const other = conv.a === pid ? conv.b : conv.a
      if (hidden(other)) continue
      out.push({ id: cid, kind: 'direct', with: other, conv })
    }
    return out
  }

  /**
   * The records of a conversation `pid` may see: with `after`, those above it,
   * oldest first; with `before`, the `limit` just below it. { seq, list, more }.
   */
  page (conv, pid, hidden, stamp, { after = null, before = null, limit = PAGE }) {
    const head = this.summary(conv, pid, hidden, stamp).seq
    const sees = (e) => {
      const m = e.k === 'm' ? e : e.msg
      return m.to.includes(pid) && (m.from === pid || !hidden(m.from))
    }
    const list = []
    let more = false
    const entries = conv.entries
    if (before !== null) {
      for (let i = this._firstAbove(conv, before - 1) - 1; i >= 0; i--) {
        if (!sees(entries[i])) continue
        if (list.length === limit) {
          more = true
          break
        }
        list.push(entries[i])
      }
      list.reverse()
    } else {
      for (let i = this._firstAbove(conv, after === null ? 0 : after); i < entries.length; i++) {
        if (!sees(entries[i])) continue
        if (list.length === limit) {
          more = true
          break
        }
        list.push(entries[i])
      }
    }
    return { seq: head, list, more }
  }

  /** A conversation by id, or null. */
  get (cid) {
    return this._convs.get(cid) || null
  }

  /** Whether `pid` takes part in a conversation (a party of a direct one; anyone in the group). */
  isParty (conv, pid) {
    return conv.kind === 'group' || conv.a === pid || conv.b === pid
  }

  // ---------------------------------------------------------------- writes

  /**
   * A message (POST). `body` checked by the caller of this (readPost); `to` the
   * profiles that keep a box, the sender first among them in order of `boxes`.
   * Resolves { created, entry } (created false: the same id came again).
   */
  post (cid, kind, a, b, sender, msg) {
    // A removed profile writes nothing more and is written to no more: a request it
    // had under way when it was removed would make its direct file again.
    if (this.isRemoved(sender) || (kind === 'direct' && (this.isRemoved(a) || this.isRemoved(b)))) return Promise.reject(apiError('no_person'))
    const conv = this._ensureConv(cid, kind, a, b)
    return this._queue(conv, async () => {
      const had = conv.byId.get(msg.id)
      if (had !== undefined) {
        const from = had.k === 'm' ? had.from : had.msg.from
        if (from !== sender) throw apiError('bad_message')
        return { created: false, entry: had, conv }
      }
      const seq = conv.seq + 1
      const e = this._message(msg.id, seq, sender, msg.at, msg.pl, msg.to, msg.boxes.map((x) => x.length), 0, 0, 0)
      const line = messageLine(e, msg.boxes)
      e.boff = line.indexOf(',"boxes":{') + BOXES_KEY.length
      e.len = line.length
      e.off = await this._append(conv, line, true)
      conv.lines++
      this._addMessage(conv, e)
      this._retain(conv)
      this._notifyConv(conv)
      await this._afterWrite(conv)
      return { created: true, entry: e, conv }
    })
  }

  /**
   * Delete a message for everyone: its sender only. Resolves when the deletion is on
   * disk and the message's boxes are gone from it.
   */
  remove (conv, pid, id) {
    return this._queue(conv, async () => {
      const e = conv.byId.get(id)
      if (e === undefined) throw apiError('message_gone')
      const from = e.k === 'm' ? e.from : e.msg.from
      if (from !== pid) throw apiError('forbidden')
      if (e.k === 'd') return
      const seq = conv.seq + 1
      await this._append(conv, deletionLine(id, seq), true)
      conv.lines++
      this._delete(conv, e, seq)
      this._notifyConv(conv)
      // Only now that the deletion is on disk: should this fail, the next start
      // finds the line still holding its boxes and writes them over then.
      try {
        await this._blank(conv, [e])
      } catch (err) {
        logError('chat file ' + conv.id + ': a deleted message not blanked yet (' + err.message + ')')
      }
      await this._afterWrite(conv)
    })
  }

  /** A read mark of `pid`, kept only when later. Resolves the one kept. */
  read (conv, pid, mark) {
    if (this.isRemoved(pid)) return Promise.reject(apiError('no_person'))
    return this._queue(conv, async () => {
      const had = conv.reads.get(pid) || null
      if (!later(mark, had)) return had
      if (conv.exists) {
        await this._append(conv, readLine(pid, mark), false)
        conv.lines++
      }
      conv.reads.set(this._intern(pid), { at: mark.at, id: mark.id })
      conv.version++
      this.notify([pid])
      await this._afterWrite(conv)
      return mark
    })
  }

  /** The access entry of `pid` in the group, kept when newer. Resolves the one kept. */
  access (pid, entry) {
    if (this.isRemoved(pid)) return Promise.reject(apiError('no_person'))
    const conv = this._ensureConv(this.groupId, 'group', null, null)
    return this._queue(conv, async () => {
      const had = conv.access.get(pid)
      if (had !== undefined && had.at >= entry.at) return had
      await this._append(conv, accessLine(pid, entry), true)
      conv.lines++
      conv.access.set(this._intern(pid), { at: entry.at, sig: entry.sig })
      conv.version++
      this.notify(null)
      await this._afterWrite(conv)
      return entry
    })
  }

  /** Everything written lands; waits end. */
  async close () {
    this._closed = true
    this.notify(null)
    await Promise.all([...this._convs.values()].map((c) => c.chain).concat([...this._aside]))
  }

  // ---------------------------------------------------------------- checks

  /** A time of a message or a read mark: whole ms, at most 5 minutes ahead, 30 days behind. */
  checkTime (at) {
    if (typeof at !== 'number') throw apiError('bad_message')
    const now = this.now()
    if (!Number.isSafeInteger(at) || at > now + AHEAD_MS || at < now - BEHIND_MS) throw apiError('bad_time')
    return at
  }

  /**
   * The body of a POST, checked: { id, at, with, boxes (pid -> box), pl }. Throws
   * bad_message (bad_time for `at`).
   */
  readPost (body) {
    if (!plainObject(body)) throw apiError('bad_message')
    for (const k of Object.keys(body)) if (!['id', 'at', 'with', 'boxes', 'playlist'].includes(k)) throw apiError('bad_message')
    if (typeof body.id !== 'string' || !HEX32_RE.test(body.id)) throw apiError('bad_message')
    const at = this.checkTime(body.at)
    if (body.with !== undefined && !isProfileId(body.with)) throw apiError('bad_message')
    if (body.playlist !== undefined && !isPlaylistId(body.playlist)) throw apiError('bad_message')
    if (!plainObject(body.boxes)) throw apiError('bad_message')
    for (const [p, box] of Object.entries(body.boxes)) if (!isProfileId(p) || !validBox(box)) throw apiError('bad_message')
    return { id: body.id, at, with: body.with === undefined ? null : body.with, boxes: body.boxes, pl: body.playlist === undefined ? null : body.playlist }
  }

  /**
   * A read mark's body: { at, id }, `at` the time of the message read (an old one
   * may be read today: only a time ahead of the clock is refused).
   */
  readMark (body) {
    if (!plainObject(body) || typeof body.id !== 'string' || !HEX32_RE.test(body.id) || Object.keys(body).some((k) => k !== 'at' && k !== 'id')) throw apiError('bad_request')
    if (typeof body.at !== 'number') throw apiError('bad_request')
    if (!Number.isSafeInteger(body.at) || body.at < 0 || body.at > this.now() + AHEAD_MS) throw apiError('bad_time')
    return { at: body.at, id: body.id }
  }
}

async function readAt (fh, off, len) {
  const buf = Buffer.alloc(len)
  await fh.read(buf, 0, len, off)
  return buf
}

/**
 * Whether an access entry is the member's own: "mpfy/chat-access/1" || the JSON of
 * [1, profileId, groupId, at], signed with the key of its card.
 */
export function accessValid (signPublicKey, profileId, groupId, at, sig) {
  if (typeof sig !== 'string' || !SIG_RE.test(sig)) return false
  try {
    return sodium.crypto_sign_verify_detached(Buffer.from(sig, 'hex'), accessBytes(profileId, groupId, at), Buffer.from(signPublicKey, 'hex'))
  } catch {
    return false
  }
}
