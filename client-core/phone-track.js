// A track of the phone's own music: from the facts the phone read of its file to
// the track the core stores (in Locale's library log) and the track it serves,
// field for field as a source serves the very same file (media.mjs buildTrack and
// library.mjs publicTrack, through phone-rules.js), plus what the network filled.
//
// The facts (F), as the host sends them:
//   { id, name, size, mtime, addedAt,
//     tags: { title, artist, album, albumArtist, trackNo, discNo, year, genres?, artistSort?,
//       albumArtistSort?, albumSort?, titleSort?, rg?: { trackGain, trackPeak, albumGain, albumPeak, r128Track, r128Album } },
//     format, codec, duration, bitrate, sampleRate, bitDepth, coverId,
//     lyrics: { synced: [[{ t, text }]], texts: [text], lrc: text | null }, was: [id] }
//
// The stored track: the built fields, `fileHash` (the id), `name`, `tagless`,
// `edited` (always empty: nobody edits a local track), `filled` (the values the
// network gave, by field, `cover` the cover id; shown while the file has no tag
// for that field), `lookup` (the details state, as a source writes it), `lyr`
// ({ kind, from, key, lookup }: an entry of the source's lyrics index), `fh` (the
// hash of the facts it was made from) and `was` (the ids of this file before its
// bytes changed).
//
// Portable: b4a, sodium-native, ./lrc.js, ./phone-rules.js.

import b4a from 'b4a'
import sodium from 'sodium-native'
import { lyricsFromParts, parseLyricsText, MAX_LYRICS_BYTES } from './lrc.js'
import { trackFromFacts, keyOf, TAGLESS_FIELDS, AUDIO_MIME } from './phone-rules.js'

export const ID_RE = /^[0-9a-f]{24}$/
const MAX_TEXT = 4096
const MAX_WAS = 8
// What a client sees of a track, in this order (library.mjs PUBLIC_FIELDS).
const PUBLIC_FIELDS = [
  'id', 'title', 'artist', 'album', 'albumArtist', 'trackNo', 'discNo', 'year', 'duration', 'format', 'mime',
  'size', 'bitrate', 'lossless', 'addedAt', 'coverId', 'fileHash', 'codec', 'sampleRate', 'bitDepth',
  'fakeLossless', 'equivKbps', 'cutoffHz', 'score', 'fp'
]
const NO_QUALITIES = '{"low":false,"normal":false,"high":false}'
// The derived code of the log (library log lines): bit 3 synced lyrics, bit 4 plain.
export const CODE_SYNCED = 8
export const CODE_PLAIN = 16

export function sha256Hex (bytes) {
  const out = b4a.alloc(sodium.crypto_hash_sha256_BYTES)
  sodium.crypto_hash_sha256(out, typeof bytes === 'string' ? b4a.from(bytes, 'utf8') : bytes)
  return b4a.toString(out, 'hex')
}

// ------------------------------------------------------------------ the facts

const text = (v) => (typeof v === 'string' && v.length <= MAX_TEXT ? v : null)
const count = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * The facts in a known shape, or null when they cannot be a track (an id that is
 * not 24 hex, a format the source does not take, no size). Unknown fields are left
 * out; a field of the wrong type counts as absent.
 */
export function cleanFacts (F) {
  if (F === null || typeof F !== 'object' || Array.isArray(F)) return null
  if (typeof F.id !== 'string' || !ID_RE.test(F.id)) return null
  if (typeof F.format !== 'string' || !Object.prototype.hasOwnProperty.call(AUDIO_MIME, F.format)) return null
  if (!Number.isSafeInteger(F.size) || F.size < 0) return null
  const tags = F.tags !== null && typeof F.tags === 'object' ? F.tags : {}
  const lyr = F.lyrics !== null && typeof F.lyrics === 'object' ? F.lyrics : {}
  const synced = Array.isArray(lyr.synced) ? lyr.synced.filter(Array.isArray) : []
  const texts = Array.isArray(lyr.texts) ? lyr.texts.filter((t) => typeof t === 'string') : []
  const lrc = typeof lyr.lrc === 'string' && lyr.lrc.length <= MAX_LYRICS_BYTES ? lyr.lrc : null
  const was = Array.isArray(F.was) ? F.was.filter((w) => typeof w === 'string' && ID_RE.test(w) && w !== F.id).slice(-MAX_WAS) : []
  return {
    id: F.id,
    name: typeof F.name === 'string' ? F.name.slice(0, MAX_TEXT) : '',
    size: F.size,
    mtime: Number.isSafeInteger(F.mtime) ? F.mtime : 0,
    addedAt: Number.isSafeInteger(F.addedAt) && F.addedAt >= 0 ? F.addedAt : 0,
    tags: {
      title: text(tags.title),
      artist: text(tags.artist),
      album: text(tags.album),
      albumArtist: text(tags.albumArtist),
      trackNo: count(tags.trackNo),
      discNo: count(tags.discNo),
      year: count(tags.year),
      ...genresOf(tags.genres),
      ...sortTagsOf(tags),
      ...gainTagsOf(tags.rg)
    },
    format: F.format,
    codec: text(F.codec),
    duration: count(F.duration),
    bitrate: count(F.bitrate),
    sampleRate: count(F.sampleRate),
    bitDepth: count(F.bitDepth),
    coverId: typeof F.coverId === 'string' && ID_RE.test(F.coverId) ? F.coverId : null,
    lyrics: { synced, texts, lrc },
    was: [...new Set(was)],
    ...scanOf(F.scan)
  }
}

// The genre tags as the host read them: strings, at most 16 of 4096 characters; none: no key.
function genresOf (g) {
  const list = Array.isArray(g) ? g.filter((s) => typeof s === 'string').slice(0, 16).map((s) => s.slice(0, MAX_TEXT)) : []
  return list.length > 0 ? { genres: list } : {}
}

// The loudness the host measured (finite LUFS, the peak or null): none, no key.
function scanOf (s) {
  if (s === null || typeof s !== 'object' || typeof s.lufs !== 'number' || !Number.isFinite(s.lufs)) return {}
  return { scan: { lufs: s.lufs, peak: typeof s.peak === 'number' && Number.isFinite(s.peak) ? s.peak : null } }
}

// The sort tags the host read: only those it has (facts without them hash as before).
function sortTagsOf (tags) {
  const out = {}
  for (const k of ['artistSort', 'albumArtistSort', 'albumSort', 'titleSort']) {
    const v = text(tags[k])
    if (v !== null) out[k] = v
  }
  return out
}

// The ReplayGain and R128 numbers the host read (loudness.js): only finite ones; none, no key.
function gainTagsOf (rg) {
  if (rg === null || typeof rg !== 'object') return {}
  const out = {}
  for (const k of ['trackGain', 'trackPeak', 'albumGain', 'albumPeak', 'r128Track', 'r128Album']) {
    if (typeof rg[k] === 'number' && Number.isFinite(rg[k])) out[k] = rg[k]
  }
  return Object.keys(out).length > 0 ? { rg: out } : {}
}

/** The hash of the facts (16 hex): a put of facts with this hash again changes nothing. */
export function factsHash (F) {
  return sha256Hex(JSON.stringify(F)).slice(0, 16)
}

/**
 * The lyrics the file gives, with the source's rules: its tags (synced over
 * plain), and an .lrc beside it only when the tags gave no synced lyrics.
 * { lyr: { kind, from }, text } or null.
 */
export function lyricsOfFacts (F) {
  const tags = lyricsFromParts(F.lyrics.synced, F.lyrics.texts)
  if (tags !== null && tags.kind === 'synced') return { kind: 'synced', from: 'tag', text: tags }
  if (F.lyrics.lrc !== null) {
    try {
      const lrc = parseLyricsText(F.lyrics.lrc)
      return { kind: lrc.kind, from: 'lrc', text: lrc }
    } catch {}
  }
  if (tags !== null) return { kind: tags.kind, from: 'tag', text: tags }
  return null
}

// ------------------------------------------------------------------ the track

/**
 * The stored track for these facts. `prev` (the stored track of the same id, or
 * null) gives what the network filled and the lookup states, which stay. Returns
 * { stored, text }: `text` the lyrics the file brings ({ kind, lines | text }, to
 * write before the track's line), else null.
 */
export function storedFromFacts (F, fh, prev = null) {
  const t = trackFromFacts(F)
  const filled = prev !== null && prev.filled !== null && typeof prev.filled === 'object' ? prev.filled : {}
  const stored = withFills({ ...t, fileHash: t.id, name: F.name, edited: [] }, filled)
  stored.filled = filled
  stored.lookup = prev !== null ? prev.lookup : null
  // What the network said of its genres (phone-lookups.js): kept while the file is the same one.
  stored.genreLookup = prev !== null && prev.genreLookup ? prev.genreLookup : null
  const own = lyricsOfFacts(F)
  const was = prev !== null ? prev.lyr : null
  let text = null
  if (own !== null) {
    stored.lyr = { kind: own.kind, from: own.from, key: keyOf(stored), lookup: was !== null ? was.lookup : null }
    text = own.text
  } else if (was !== null && (was.from === 'lrclib' || was.from === null)) {
    // As LRCLIB was asked about this file (its key, its state, what it found): a
    // key that moved asks again.
    stored.lyr = { ...was }
  } else {
    stored.lyr = { kind: null, from: null, key: keyOf(stored), lookup: null }
  }
  stored.fh = fh
  stored.was = F.was
  return { stored, text }
}

// The values the network filled, on the fields the file has no tag for.
function withFills (t, filled) {
  for (const f of TAGLESS_FIELDS) {
    const v = filled[f]
    if (v === undefined || v === null || v === '' || !t.tagless.includes(f)) continue
    if (f === 'cover') t.coverId = v
    else t[f] = v
  }
  return t
}

/** The derived code of a stored track (its lyrics). */
export function codeOf (stored) {
  const k = stored.lyr !== null ? stored.lyr.kind : null
  return k === 'synced' ? CODE_SYNCED : k === 'plain' ? CODE_PLAIN : 0
}

/** "synced", "plain" or null: what the library shows of a track's lyrics. */
export function shownLyrics (stored) {
  const k = stored.lyr !== null ? stored.lyr.kind : null
  return k === 'synced' || k === 'plain' ? k : null
}

/**
 * The served track, as JSON text: the public fields in their order (null when
 * absent), no Opus versions, its lyrics flag, nobody's upload, and `was` when the
 * file changed in place.
 */
export function servedText (stored) {
  const out = {}
  for (const k of PUBLIC_FIELDS) out[k] = stored[k] === undefined ? null : stored[k]
  let s = JSON.stringify(out).slice(0, -1)
  const gl = stored.genreLookup
  if (Array.isArray(stored.genres) && stored.genres.length > 0) s += ',"genres":' + JSON.stringify(stored.genres)
  else if (gl && gl.fileHash === stored.fileHash && Array.isArray(gl.genres) && gl.genres.length > 0) s += ',"genres":' + JSON.stringify(gl.genres)
  if (stored.sort) s += ',"sort":' + JSON.stringify(stored.sort)
  if (stored.loud) s += ',"loud":' + JSON.stringify(stored.loud)
  s += ',"qualities":' + NO_QUALITIES
  const lyrics = shownLyrics(stored)
  if (lyrics !== null) s += ',"lyrics":"' + lyrics + '"'
  s += ',"mine":false,"others":true'
  if (Array.isArray(stored.was) && stored.was.length > 0) s += ',"was":' + JSON.stringify(stored.was)
  return s + '}'
}

/**
 * The stored track once a details lookup is over (server/details.mjs _finish):
 * the fields it found among those still missing, its state, the cover id.
 */
export function withDetails (stored, { state, recording = null, release = null, values = null, coverId = null, tries, at }, missing) {
  const next = { ...stored, filled: { ...stored.filled } }
  const found = []
  if (values !== null) {
    const all = { ...values, cover: coverId }
    for (const f of TAGLESS_FIELDS) {
      if (!missing.includes(f) || all[f] === null || all[f] === undefined || all[f] === '') continue
      next.filled[f] = all[f]
      if (f === 'cover') next.coverId = all[f]
      else next[f] = all[f]
      found.push(f)
    }
  }
  const before = stored.lookup && Array.isArray(stored.lookup.filled) ? stored.lookup.filled : []
  const open = (f) => Array.isArray(stored.tagless) && stored.tagless.includes(f)
  const filled = TAGLESS_FIELDS.filter((f) => found.includes(f) || (before.includes(f) && open(f)))
  next.lookup = { v: 1, state, at, tries, fileHash: stored.fileHash, acoustid: null, recording, release, filled }
  return { next, found }
}
