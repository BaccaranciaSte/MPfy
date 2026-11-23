// Lyrics texts: the LRC parser (lines with their times), plain texts, their
// limits, and the lyrics a file's tags carry. Shared by the tags of an upload, an
// .lrc file and LRCLIB.
//
// LRC: time tags [mm:ss], [mm:ss.x], [mm:ss.xx], [mm:ss.xxx] at the start of a
// line, several on one line (the line is repeated at each time); [offset:+-ms]
// moves every time (a positive offset shows the lines sooner); [ar:], [ti:],
// [al:], [by:], [length:] and any other tag are left out; word times <mm:ss.xx>
// are removed from the text; a line without a time tag is no line of a synced
// text; a time tag with no text is kept (a pause). Lines are sorted by time,
// those of the same time in the order they came.
// Limits: 64 KB of text, 2,000 lines, a line 500 code points (longer ones are
// cut). Beyond them, or with nothing left to show, the text is refused. A tag of
// a hostile file may hold far more than that: the work stays bounded by the
// limits, never by the size of the tag (a text over 64 KB is refused before it is
// read, a synced tag is read until its 2,001st line, a line is cut before it is
// cleaned).
//
// This file imports nothing: the phone's core runs a byte-for-byte copy of it
// (client-core/lrc.js), on runtimes with no Buffer and no TextEncoder.

export const MAX_LYRICS_BYTES = 64 * 1024
export const MAX_LINES = 2000
export const MAX_LINE = 500
// What of a line is cleaned at most (UTF-16 units): far more than a line keeps,
// even when spaces collapse.
const RAW_LINE = 8 * MAX_LINE

/** A text that cannot be lyrics (400 bad_lyrics where a person sent it). */
export class LyricsError extends Error {}

const TAG_RE = /^\[([^\]\n]*)\]/
const TIME_RE = /^(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?$/
const OFFSET_RE = /^offset\s*:\s*([+-]?\d{1,9})\s*$/i
// A tag line of the LRC header, left out of a plain text too.
const META_LINE_RE = /^\[(?:ar|ti|al|au|by|re|ve|length|offset|id|#)\s*:[^\]]*\]$/i
const WORD_TIME_RE = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\ufeff]/g

// The first n UTF-16 units of s, one less when the last would split a pair.
function headOf (s, n) {
  if (s.length <= n) return s
  const c = s.charCodeAt(n - 1)
  return s.slice(0, c >= 0xd800 && c <= 0xdbff ? n - 1 : n)
}

// The first 500 code points: they lie within the first 1,000 units, so no more
// than those are split into code points.
function lineCut (s) {
  if (s.length <= MAX_LINE) return s
  return Array.from(headOf(s, 2 * MAX_LINE)).slice(0, MAX_LINE).join('')
}

// One line of text as shown: controls and tabs become spaces, runs of spaces
// collapse, trimmed, cut at 500 code points.
function cleanText (s) {
  return lineCut(headOf(s, RAW_LINE).replace(CONTROL_RE, ' ').replace(/\t/g, ' ').replace(/ {2,}/g, ' ').trim())
}

// A UTF-8 byte at least for each UTF-16 unit: a string longer than this in units is
// over 64 KB, told without reading it.
const tooLong = (text) => typeof text === 'string' && text.length > MAX_LYRICS_BYTES

/** The length of a string in UTF-8 bytes (a lone surrogate as the 3 bytes of U+FFFD). */
export function utf8Length (s) {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4
      i++
    } else n += 3
  }
  return n
}

function linesOf (text) {
  if (typeof text !== 'string') throw new LyricsError('not a text')
  if (tooLong(text) || utf8Length(text) > MAX_LYRICS_BYTES) throw new LyricsError('over 64 KB')
  return text.replace(/^\ufeff/, '').replace(/\r\n?/g, '\n').split('\n')
}

// The tags at the start of a line: { times: [ms], offset: ms|null, rest }.
function leadingTags (line) {
  const times = []
  let offset = null
  let rest = line.replace(/^[ \t]+/, '')
  for (let m = TAG_RE.exec(rest); m !== null; m = TAG_RE.exec(rest)) {
    const inner = m[1].trim()
    const t = TIME_RE.exec(inner)
    if (t !== null) {
      const frac = t[3] === undefined ? 0 : Number(t[3].padEnd(3, '0'))
      times.push((Number(t[1]) * 60 + Number(t[2])) * 1000 + frac)
    } else {
      const o = OFFSET_RE.exec(inner)
      if (o !== null) offset = Number(o[1])
    }
    rest = rest.slice(m[0].length)
  }
  return { times, offset, rest }
}

/** Does the text have a line that starts with a time tag? */
export function hasTimeTag (text) {
  for (const line of String(text).replace(/\r\n?/g, '\n').split('\n')) {
    if (leadingTags(line).times.length > 0) return true
  }
  return false
}

/**
 * Is a text from a tag LRC: at least 3 lines with a time tag, and more than half
 * of the lines that are not empty with one?
 */
export function isLrcText (text) {
  let timed = 0
  let full = 0
  for (const line of String(text).replace(/\r\n?/g, '\n').split('\n')) {
    if (line.trim() === '') continue
    full++
    if (leadingTags(line).times.length > 0) timed++
  }
  return timed >= 3 && timed * 2 > full
}

/** LRC to { kind: 'synced', lines: [{ t, text }] }. Throws LyricsError. */
export function parseLrc (text) {
  const raw = linesOf(text)
  let offset = 0
  const parsed = []
  for (const line of raw) {
    const tags = leadingTags(line)
    if (tags.offset !== null) offset = tags.offset
    if (tags.times.length > 0) parsed.push(tags)
  }
  const lines = []
  for (const { times, rest } of parsed) {
    const words = cleanText(rest.replace(WORD_TIME_RE, ''))
    for (const t of times) {
      lines.push({ t: Math.max(0, t - offset), text: words })
      if (lines.length > MAX_LINES) throw new LyricsError('over 2,000 lines')
    }
  }
  if (!lines.some((l) => l.text !== '')) throw new LyricsError('no line to show')
  lines.sort((a, b) => a.t - b.t)
  return { kind: 'synced', lines }
}

/** A plain text to { kind: 'plain', text }: header tags out, lines cleaned. Throws LyricsError. */
export function parsePlain (text) {
  const lines = linesOf(text).filter((l) => !META_LINE_RE.test(l.trim())).map(cleanText)
  while (lines.length > 0 && lines[0] === '') lines.shift()
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  if (lines.length === 0) throw new LyricsError('empty')
  if (lines.length > MAX_LINES) throw new LyricsError('over 2,000 lines')
  return { kind: 'plain', text: lines.join('\n') }
}

/** A text a person sent (PUT, an .lrc file): synced when a line has a time tag, else plain. */
export function parseLyricsText (text) {
  if (tooLong(text)) throw new LyricsError('over 64 KB')
  return hasTimeTag(text) ? parseLrc(text) : parsePlain(text)
}

/**
 * Lyrics already in lines (a tag's): checked, cleaned and sorted. `timeOf(item)`
 * gives an item's time in ms ({ t } by default). The items are read one by one,
 * no further than the limits. Throws LyricsError.
 */
export function syncedFrom (items, timeOf = (it) => it.t) {
  const lines = []
  let bytes = 0
  for (const it of items) {
    const t = it ? timeOf(it) : NaN
    if (!it || typeof it.text !== 'string' || !Number.isFinite(t) || t < 0) continue
    const text = cleanText(headOf(it.text, RAW_LINE).replace(/^[\r\n]+/, ''))
    lines.push({ t: Math.round(t), text })
    if (lines.length > MAX_LINES) throw new LyricsError('over 2,000 lines')
    bytes += utf8Length(text) + 1
    if (bytes > MAX_LYRICS_BYTES) throw new LyricsError('over 64 KB')
  }
  if (!lines.some((l) => l.text !== '')) throw new LyricsError('no line to show')
  lines.sort((a, b) => a.t - b.t)
  return { kind: 'synced', lines }
}

const syncTime = (s) => s.timestamp

// A text found in a tag: LRC when it looks like it, else plain; null when it is
// no lyrics at all (or more than 64 KB: refused before it is read).
function fromTagText (text) {
  if (typeof text !== 'string' || tooLong(text) || text.trim() === '') return null
  try {
    return isLrcText(text) ? parseLrc(text) : parsePlain(text)
  } catch {
    return null
  }
}

// The native tags that hold lyrics, by the id each format gives them.
const SYNCED_IDS = new Set(['SYLT', 'SLT'])
const TEXT_IDS = new Set(['USLT', 'ULT', 'LYRICS', 'UNSYNCEDLYRICS', 'UNSYNCED LYRICS', '©lyr', 'WM/Lyrics'])

/**
 * The lyrics of a file from what its tags hold: `synced`, lists of lines with
 * their times in milliseconds (an ID3 SYLT; `timeOf(item)` gives an item's time,
 * { t } by default), and `texts` (ID3 USLT, Vorbis LYRICS, MP4 ©lyr). A synced
 * list is checked, cleaned and sorted; a text that is LRC goes through the LRC
 * parser, else it is plain. Synced wins over plain; among each kind the first that
 * is lyrics wins, the lists before the texts. The lists are read one item at a
 * time, never copied, so the limits bound the work. Returns { kind, lines | text }
 * or null.
 */
export function lyricsFromParts (synced, texts, timeOf = (it) => it.t) {
  let found = null
  let plain = null
  const take = (lyr) => {
    if (lyr === null) return
    if (lyr.kind === 'synced') found = found || lyr
    else plain = plain || lyr
  }
  for (const items of Array.isArray(synced) ? synced : []) {
    if (!Array.isArray(items)) continue
    try {
      take(syncedFrom(items, timeOf))
    } catch {}
  }
  for (const text of Array.isArray(texts) ? texts : []) take(fromTagText(text))
  return found || plain
}

/**
 * What the tags of a file hold for its lyrics, from the music-metadata parse:
 * { synced: [the syncText lists of the SYLT tags in milliseconds], texts: [...] }.
 * The raw texts are read where the parse keeps them (`native`), so an LRC in a
 * Vorbis or MP4 tag keeps its offset and its lines with several times; any other
 * format falls back on `common.lyrics`. The items of a list carry `timestamp`.
 */
export function lyricsPartsOf (metadata) {
  const synced = []
  const texts = []
  const native = metadata && metadata.native && typeof metadata.native === 'object' ? metadata.native : {}
  let found = false
  for (const tags of Object.values(native)) {
    if (!Array.isArray(tags)) continue
    for (const tag of tags) {
      if (!tag || typeof tag.id !== 'string') continue
      const id = tag.id
      const v = tag.value
      if (SYNCED_IDS.has(id)) {
        found = true
        if (v && v.timeStampFormat === 2 && Array.isArray(v.syncText)) synced.push(v.syncText)
      } else if (TEXT_IDS.has(id) || TEXT_IDS.has(id.toUpperCase())) {
        found = true
        texts.push(typeof v === 'string' ? v : v && typeof v.text === 'string' ? v.text : null)
      }
    }
  }
  if (!found) {
    const list = metadata && metadata.common && Array.isArray(metadata.common.lyrics) ? metadata.common.lyrics : []
    for (const e of list) {
      if (!e || typeof e !== 'object') continue
      if (e.timeStampFormat === 2 && Array.isArray(e.syncText) && e.syncText.length > 0) synced.push(e.syncText)
      else texts.push(e.text)
    }
  }
  return { synced, texts }
}

/**
 * The lyrics of a file from the music-metadata parse of its tags: an ID3 SYLT in
 * milliseconds is synced; a text (ID3 USLT, Vorbis LYRICS, MP4 ©lyr) that is LRC
 * goes through the LRC parser, else it is plain. Synced wins over plain (a SYLT
 * over an LRC text). Returns { kind, lines | text } or null.
 */
export function lyricsFromTags (metadata) {
  const { synced, texts } = lyricsPartsOf(metadata)
  return lyricsFromParts(synced, texts, syncTime)
}
