// The source's rules for the phone's own music, in the core: how a track is built
// from what its file holds (server/media.mjs buildTrack, taglessOf, isLossless,
// quality.mjs codecOf, ids.mjs titleFromFileName and cleanUploadName), the details
// from the network (server/details.mjs: the hints, the text search, the release,
// the values, what is missing, the pacing) and the lyrics from LRCLIB
// (server/lyrics.mjs: the key, who may be asked, the query, Retry-After). Those
// files import node: modules, so these are copies, checked against them on the
// same inputs by test/unit-phone-rules.test.mjs. The one rule that is the phone's
// own: MusicBrainz and the Cover Art Archive are asked once every 3 s (PHONE_PACE),
// since every phone of a family shares one public address with its source and
// MusicBrainz counts requests per address.
//
// Portable: b4a, sodium-native (SHA-256), and ./versions.js; no URL, no
// URLSearchParams, no Buffer.

import b4a from 'b4a'
import sodium from 'sodium-native'
import { differentVersions } from './versions.js'
import { splitGenres } from '../web/js/genres.js'
import { loudFromTags, loudFromScan } from '../web/js/loudness.js'

export const UNKNOWN_ARTIST = 'Artista sconosciuto'
export const UNKNOWN_ALBUM = 'Album sconosciuto'
// The fields a track may get from its file's tags (and `cover`, its picture).
export const TAGLESS_FIELDS = ['title', 'artist', 'albumArtist', 'album', 'year', 'trackNo', 'discNo', 'cover']
export const AUDIO_MIME = {
  mp3: 'audio/mpeg',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav'
}

// ------------------------------------------------------------------- the track

/** A tag as a track shows it: controls become spaces, trimmed, at most `max` units. */
export function cleanTag (value, max = 500) {
  if (typeof value !== 'string') return ''
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max)
}

function positiveInt (n) {
  return Number.isInteger(n) && n > 0 ? n : null
}

/** A file name made safe to show: last path component, no control or bidi characters, 255 units. */
export function cleanUploadName (raw) {
  let name = String(raw || '')
  name = name.split(/[\\/]/).pop()
  name = name.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')
  return name.trim().slice(0, 255)
}

/** "Song name.mp3" -> "Song name"; an empty result falls back to `fallback`. */
export function titleFromFileName (name, fallback) {
  const dot = name.lastIndexOf('.')
  const base = (dot > 0 ? name.slice(0, dot) : name).trim()
  return base || fallback
}

/** Lossless original? FLAC, WAV, or ALAC inside MP4 (`codec` the file's codec name or MIME). */
export function isLossless (format, codec) {
  if (format === 'flac' || format === 'wav') return true
  if (format !== 'm4a') return false
  return /alac/i.test(String(codec || ''))
}

export function codecOf (format, lossless, parsedCodec = '') {
  const c = String(parsedCodec || '').toLowerCase()
  switch (format) {
    case 'mp3': return 'mp3'
    case 'aac': return 'aac'
    case 'm4a': return lossless || /alac/.test(c) ? 'alac' : 'aac'
    case 'flac': return 'flac'
    case 'opus': return 'opus'
    case 'ogg': return /flac/.test(c) ? 'flac' : /opus/.test(c) ? 'opus' : 'vorbis'
    case 'wav': return 'wav'
    default: return null
  }
}

/** The fields the file has no tag for (`tags` as the phone reads them); `cover`: no picture. */
export function taglessOf (tags, coverId) {
  const c = tags || {}
  const out = []
  if (!cleanTag(c.title)) out.push('title')
  if (!cleanTag(c.artist)) out.push('artist')
  if (!cleanTag(c.albumArtist)) out.push('albumArtist')
  if (!cleanTag(c.album)) out.push('album')
  if (positiveInt(c.year) === null) out.push('year')
  if (positiveInt(c.trackNo) === null) out.push('trackNo')
  if (positiveInt(c.discNo) === null) out.push('discNo')
  if (!coverId) out.push('cover')
  return out
}

/**
 * The track the source would build for the very same file (media.mjs buildTrack),
 * from the facts the phone read: { id, name, size, addedAt, tags, format, codec,
 * duration, bitrate, sampleRate, bitDepth, coverId }.
 */
export function trackFromFacts (F) {
  const tags = F.tags || {}
  const num = (v) => typeof v === 'number' && Number.isFinite(v)
  const title = cleanTag(tags.title) || titleFromFileName(cleanUploadName(F.name), F.id) || F.id
  const artist = cleanTag(tags.artist) || UNKNOWN_ARTIST
  const album = cleanTag(tags.album) || UNKNOWN_ALBUM
  const albumArtist = cleanTag(tags.albumArtist) || artist
  const lossless = isLossless(F.format, F.codec)
  return {
    id: F.id,
    title,
    artist,
    album,
    albumArtist,
    trackNo: positiveInt(tags.trackNo),
    discNo: positiveInt(tags.discNo),
    year: positiveInt(tags.year),
    duration: num(F.duration) ? Math.round(F.duration * 1000) / 1000 : null,
    format: F.format,
    mime: AUDIO_MIME[F.format],
    size: F.size,
    bitrate: num(F.bitrate) ? Math.round(F.bitrate) : null,
    lossless,
    addedAt: F.addedAt,
    coverId: F.coverId || null,
    codec: codecOf(F.format, lossless, F.codec),
    sampleRate: typeof F.sampleRate === 'number' && F.sampleRate > 0 ? Math.round(F.sampleRate) : null,
    bitDepth: lossless && typeof F.bitDepth === 'number' && F.bitDepth > 0 ? F.bitDepth : null,
    tagless: taglessOf(tags, F.coverId),
    genres: splitGenres(tags.genres || []),
    sort: sortOf(tags),
    // The tags' first, else what the phone measured (the source's own measure is a job, after the build).
    loud: loudFromTags(tags.rg) || (F.scan && typeof F.scan === 'object' ? loudFromScan(F.scan.lufs, F.scan.peak) : null)
  }
}

// The sort tags (media.mjs sortOf).
function sortOf (tags) {
  const out = {}
  for (const [k, v] of [['artist', tags.artistSort], ['albumArtist', tags.albumArtistSort], ['album', tags.albumSort], ['title', tags.titleSort]]) {
    const x = cleanTag(v)
    if (x) out[k] = x
  }
  return Object.keys(out).length > 0 ? out : null
}

// ----------------------------------------------------------------- the details

export const MB_URL = 'https://musicbrainz.org'
export const CAA_URL = 'https://coverartarchive.org'
export const LRCLIB_URL = 'https://lrclib.net'
// The source's pace (ms between two request starts, per service), and the phone's.
export const PACE = Object.freeze({ musicbrainz: 1000, caa: 1000 })
export const PHONE_PACE = Object.freeze({ musicbrainz: 3000, caa: 3000 })
export const DETAILS_BACKOFF = [5000, 10000, 20000, 40000, 60000]
export const THROTTLED_FAIL = 3
export const FILL_DELAY_MS = 60000
export const DETAILS_RETRY_BASE_MS = 6 * 3600 * 1000
export const DETAILS_MAX_TRIES = 4
// No answer at all (no network): the queue waits, doubling to 30 min.
export const OFFLINE_PAUSE = [60000, 120000, 240000, 480000, 960000, 1800000]
export const CAA_KEEP = 2000
export const LOOKUP_FIELDS = ['title', 'artist', 'album', 'cover']
export const RELEASE_PAGE = 100
export const RELEASE_PAGES = 3

/** The User-Agent of every request, the source's own. */
export function userAgentOf (version) {
  return 'MPfy/' + version + ' ( https://github.com/BaccaranciaSte/MPfy )'
}

const BRACKETS = /\([^)]*\)|\[[^\]]*\]|【[^】]*】|（[^）]*）/g
const FEAT_TAIL = /\s(?:feat|ft)\.\s.*$/s

/** A text reduced for comparing: NFKC, lowercase, brackets and a " feat. ..." tail out, letters and digits. */
export function norm (s) {
  let t = String(s || '').normalize('NFKC').toLowerCase()
  t = t.replace(BRACKETS, ' ')
  t = t.replace(FEAT_TAIL, '')
  return t.replace(/[^\p{L}\p{N}]/gu, '')
}

function wordsOf (s) {
  let t = String(s || '').normalize('NFKC').toLowerCase()
  t = t.replace(BRACKETS, ' ')
  t = t.replace(FEAT_TAIL, '')
  return t.split(/[^\p{L}\p{N}]+/u).filter((w) => w !== '')
}

const cps = (s) => Array.from(s).length

/** Two normalized texts match: equal, or one holds the other and the shorter has 4 characters or more. */
export function textsMatch (a, b) {
  if (!a || !b) return false
  if (a === b) return true
  const [short, long] = cps(a) <= cps(b) ? [a, b] : [b, a]
  return cps(short) >= 4 && long.includes(short)
}

const STORE_SUFFIX = /\s+[-\u2013\u2014]\s+(?:ep|single|maxi[\s-]?single)\s*$|\s*[(\[](?:ep|single|maxi[\s-]?single)[)\]]\s*$/i
const EDITION_WORDS = new Set([
  'deluxe', 'edition', 'expanded', 'remaster', 'remastered', 'anniversary', 'version', 'special', 'bonus', 'track', 'tracks',
  'ep', 'single', 'digital'
])
const editionWord = (w) => EDITION_WORDS.has(w) || /^(?:19|20)\d\d$/.test(w) || /^\d+(?:st|nd|rd|th)$/.test(w)

function albumOf (s) {
  const text = String(s || '').normalize('NFKC').toLowerCase().trim().replace(STORE_SUFFIX, '').trim()
  return { text, words: wordsOf(text) }
}

/** Two album titles are the same title (a store's " - EP" aside; signs as they are written). */
export function sameAlbum (a, b) {
  const x = albumOf(a)
  const y = albumOf(b)
  if (x.words.length === 0 || y.words.length === 0) return x.words.length === y.words.length && x.text !== '' && x.text === y.text
  return x.words.join('') === y.words.join('')
}

/** Two album titles name one album: the same title, or one is the other and then only edition words. */
export function albumsMatch (a, b) {
  if (sameAlbum(a, b)) return true
  const x = albumOf(a).words
  const y = albumOf(b).words
  if (x.length === 0 || y.length === 0) return false
  return editionOf(x, y) || editionOf(y, x)
}

function editionOf (short, long) {
  const want = short.join('')
  let head = ''
  for (let k = 0; k < long.length - 1; k++) {
    head += long[k]
    if (head === want) return long.slice(k + 1).every(editionWord)
    if (!want.startsWith(head)) return false
  }
  return false
}

const JUNK_RE = /^(track|traccia|pista|audio|unknown|untitled|senzatitolo)\d*$/
const LEADING_NO_RE = /^\d{1,3}[\s._)-]+/

export function stripTrackNo (s) {
  return String(s || '').replace(LEADING_NO_RE, '')
}

/** A title nobody types: "traccia02", "Track 7" (a leading track number aside). */
export function junkTitle (title) {
  return JUNK_RE.test(norm(stripTrackNo(title)))
}

/** A title hint worth sending: a letter in it, and not a junk name. */
export function usableTitle (hint) {
  const n = norm(hint)
  return /\p{L}/u.test(n) && !JUNK_RE.test(n)
}

/**
 * The hints of a track: the title (a file name for a tagless one) without its
 * leading track number; "Artist - Title" split when the file has no artist tag;
 * the artist when it has one. A title that is the track's own id is never a hint.
 */
export function hintsOf (t) {
  let title = stripTrackNo(t.title).trim()
  let artist = null
  const tagless = Array.isArray(t.tagless) ? t.tagless : []
  const edited = Array.isArray(t.edited) ? t.edited : []
  if ((!tagless.includes('artist') || edited.includes('artist')) && t.artist && t.artist !== UNKNOWN_ARTIST) {
    artist = t.artist
  } else if (title.includes(' - ')) {
    const i = title.lastIndexOf(' - ')
    artist = title.slice(0, i).trim() || null
    title = title.slice(i + 3).trim()
  }
  const ownId = t.title === t.id || /^[0-9a-f]{24}$/.test(title)
  return { title, artist, usable: !ownId && usableTitle(title) }
}

/** Names with their join phrases (", " between two names when a phrase is absent). */
export function artistText (credits) {
  if (!Array.isArray(credits)) return ''
  let s = ''
  credits.forEach((c, i) => {
    if (!c || typeof c.name !== 'string') return
    s += c.name
    if (typeof c.joinphrase === 'string') s += c.joinphrase
    else if (i < credits.length - 1) s += ', '
  })
  return s.trim()
}

function clean (value, max = 500) {
  if (typeof value !== 'string') return ''
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max)
}

/**
 * The fields a lookup may write on this track. `values`: what this lookup found;
 * null: before the lookup. The phone has no custom covers and no person edits.
 */
export function missingFields (t, values = null) {
  if (!Array.isArray(t.tagless)) return []
  const edited = Array.isArray(t.edited) ? t.edited : []
  const open = (f) => t.tagless.includes(f) && !edited.includes(f)
  const fills = (f) => values !== null && values[f] !== null && values[f] !== undefined && values[f] !== ''
  const out = []
  if (open('title') && (t.editedUnknown !== true || junkTitle(t.title))) out.push('title')
  if (open('artist') && t.artist === UNKNOWN_ARTIST) out.push('artist')
  const album = open('album') && t.album === UNKNOWN_ALBUM
  if (open('albumArtist') && (t.albumArtist === UNKNOWN_ARTIST || (album && fills('album')))) out.push('albumArtist')
  if (album) out.push('album')
  if (open('year') && t.year === null) out.push('year')
  const trackNo = open('trackNo') && t.trackNo === null
  if (trackNo) out.push('trackNo')
  if (open('discNo') && t.discNo === null && trackNo && fills('trackNo')) out.push('discNo')
  if (open('cover') && t.coverId === null) out.push('cover')
  return out
}

/** Does this track start a lookup (a title, artist, album or cover missing)? */
export function wantsLookup (t) {
  return missingFields(t, null).some((f) => LOOKUP_FIELDS.includes(f))
}

function rankOf (release) {
  const rg = release['release-group'] || {}
  const secondary = Array.isArray(rg['secondary-types']) ? rg['secondary-types'] : []
  if (rg['primary-type'] === 'Album' && secondary.length === 0) return 0
  if (rg['primary-type'] === 'EP') return 1
  if (rg['primary-type'] === 'Single') return 2
  return 3
}

const groupOf = (r) => (r && r['release-group'] && typeof r['release-group'].id === 'string' ? r['release-group'].id : null)
const groupTitleOf = (r) => (r && r['release-group'] && typeof r['release-group'].title === 'string' ? r['release-group'].title : null)

function namedLike (releases, albumHint) {
  const fits = (r, match) => match(r.title, albumHint) || (groupTitleOf(r) !== null && match(groupTitleOf(r), albumHint))
  const same = releases.filter((r) => fits(r, sameAlbum))
  return same.length > 0 ? same : releases.filter((r) => fits(r, albumsMatch))
}

/** The release of a recording: official first, the one titled like the album tag, the lowest rank, the earliest, the smallest id. */
export function chooseRelease (releases, albumHint = null) {
  const all = (Array.isArray(releases) ? releases : []).filter((r) => r && typeof r.id === 'string')
  const official = all.filter((r) => r.status === 'Official')
  let pool = official.length > 0 ? official : all
  if (albumHint) {
    const named = namedLike(all, albumHint)
    if (named.length > 0) {
      const own = named.filter((r) => r.status === 'Official')
      const groups = new Set(named.map(groupOf).filter((g) => g !== null))
      const kin = official.filter((r) => groups.has(groupOf(r)))
      pool = own.length > 0 ? own : kin.length > 0 ? kin : named
    }
  }
  const date = (r) => (typeof r.date === 'string' && /^\d{4}/.test(r.date) ? r.date : null)
  return pool.slice().sort((a, b) => {
    const d = rankOf(a) - rankOf(b)
    if (d !== 0) return d
    const da = date(a)
    const db = date(b)
    if (da !== db) {
      if (da === null) return 1
      if (db === null) return -1
      return da < db ? -1 : 1
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })[0] || null
}

/** Is this the album the file names? With no album tag any release is. */
export function releaseFits (release, albumHint, releases = []) {
  if (!albumHint) return true
  if (!release) return false
  if (albumsMatch(release.title, albumHint)) return true
  if (groupTitleOf(release) !== null && albumsMatch(groupTitleOf(release), albumHint)) return true
  const group = groupOf(release)
  return group !== null && (Array.isArray(releases) ? releases : []).some((r) => groupOf(r) === group && albumsMatch(r.title, albumHint))
}

function yearOf (release) {
  const rg = release['release-group'] || {}
  for (const d of [release.date, rg['first-release-date']]) {
    const m = typeof d === 'string' ? /^(\d{4})/.exec(d) : null
    if (m !== null && Number(m[1]) > 0) return Number(m[1])
  }
  return null
}

/** What a recording and its release give a track. */
export function valuesOf (recording, release, positions = null) {
  const v = {
    title: clean(recording.title) || null,
    artist: clean(artistText(recording['artist-credit'])) || null,
    album: null,
    albumArtist: null,
    year: null,
    trackNo: null,
    discNo: null
  }
  if (release !== null) {
    v.album = clean(release.title) || null
    v.albumArtist = clean(artistText(release['artist-credit'])) || null
    v.year = yearOf(release)
    if (positions !== null) {
      v.trackNo = positions.trackNo
      v.discNo = positions.discNo
    } else {
      const medium = Array.isArray(release.media) ? release.media[0] : null
      const track = medium && Array.isArray(medium.tracks) ? medium.tracks[0] : null
      v.trackNo = track ? positiveInt(track.position) : null
      v.discNo = medium ? positiveInt(medium.position) : null
    }
  }
  return v
}

/** The disc and track of a recording on a release (a release lookup with recordings). */
export function positionsOf (release, recordingId) {
  for (const medium of Array.isArray(release && release.media) ? release.media : []) {
    for (const track of Array.isArray(medium.tracks) ? medium.tracks : []) {
      if (track && track.recording && track.recording.id === recordingId) {
        return { trackNo: positiveInt(track.position), discNo: positiveInt(medium.position) }
      }
    }
  }
  return { trackNo: null, discNo: null }
}

/** The text search query: the hints as phrases, the duration within 3 s. */
export function searchQuery (hints, ms) {
  const esc = (s) => String(s).replace(/[\\"]/g, (c) => '\\' + c)
  let q = 'recording:"' + esc(hints.title) + '"'
  if (hints.artist) q += ' AND artist:"' + esc(hints.artist) + '"'
  return q + ' AND dur:[' + (ms - 3000) + ' TO ' + (ms + 3000) + ']'
}

/** The recording of a text search, or null: score 90, length within 3 s, the exact title, one artist credit. */
export function chooseFromSearch (answer, hints, ms) {
  const recordings = answer && Array.isArray(answer.recordings) ? answer.recordings : []
  const title = norm(hints.title)
  const artist = hints.artist ? norm(hints.artist) : null
  const accepted = recordings.filter((r) => r && typeof r.id === 'string' &&
    typeof r.score === 'number' && r.score >= 90 &&
    typeof r.length === 'number' && Math.abs(r.length - ms) <= 3000 &&
    title !== '' && norm(r.title) === title && !differentVersions(r.title, hints.title) &&
    (artist === null || textsMatch(norm(artistText(r['artist-credit'])), artist)))
  const credits = new Set(accepted.map((r) => artistText(r['artist-credit'])))
  if (credits.size !== 1) return null
  return accepted.slice().sort((a, b) => b.score - a.score)[0]
}

/**
 * One per service: a request starts at least `interval` ms after the previous one
 * started AND after its answer came, and a pause after a 429 or 503 (5 s,
 * doubling to 60 s, until a normal answer). `now` and `wait(ms)` are the clock.
 */
export class Pacer {
  constructor (interval, backoff = DETAILS_BACKOFF, { now = Date.now, wait = sleep } = {}) {
    this.interval = interval
    this.backoff = backoff
    this.now = now
    this.wait = wait
    this.last = -Infinity
    this.pauseUntil = 0
    this.level = 0
    this._tail = Promise.resolve()
  }

  slot () {
    const turn = this._tail.then(async () => {
      const ms = Math.max(this.last + this.interval, this.pauseUntil) - this.now()
      if (ms > 0) await this.wait(ms)
      this.last = this.now()
    })
    this._tail = turn.catch(() => {})
    return turn
  }

  /** The answer came (or the request failed): the next one counts from now. */
  done () {
    this.last = this.now()
  }

  throttled () {
    this.pauseUntil = this.now() + this.backoff[Math.min(this.level, this.backoff.length - 1)]
    this.level++
  }

  calm () {
    this.level = 0
  }
}

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ------------------------------------------------------------------ the lyrics

export const LYRICS_PACE_MS = 1500
export const LYRICS_BACKOFF = [5000, 10000, 20000, 40000, 60000]
export const MAX_RETRY_AFTER_MS = 3600 * 1000
export const LYRICS_RETRY_BASE_MS = 6 * 3600 * 1000
export const LYRICS_MAX_TRIES = 5 // the first try and four more
export const MISS_RETRY_MS = 30 * 24 * 3600 * 1000

function sha256Hex (text) {
  const out = b4a.alloc(sodium.crypto_hash_sha256_BYTES)
  sodium.crypto_hash_sha256(out, b4a.from(text, 'utf8'))
  return b4a.toString(out, 'hex')
}

/** The key of a track: what LRCLIB is asked about it. */
export function keyOf (t) {
  const seconds = typeof t.duration === 'number' && Number.isFinite(t.duration) ? Math.round(t.duration) : 0
  return sha256Hex(wellFormed(t.title + '\u0000' + t.artist + '\u0000' + t.album + '\u0000' + seconds)).slice(0, 16)
}

/** Can LRCLIB be asked about this track: a title, a known artist, a duration? */
export function askable (t) {
  return typeof t.title === 'string' && t.title !== '' && t.title !== t.id &&
    typeof t.artist === 'string' && t.artist !== '' && t.artist !== UNKNOWN_ARTIST &&
    typeof t.duration === 'number' && Number.isFinite(t.duration) && t.duration > 0
}

// A lone surrogate becomes U+FFFD, as every UTF-8 encoder writes it.
function wellFormed (s) {
  return String(s).replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '\ufffd')
}

// application/x-www-form-urlencoded, as URLSearchParams writes a value.
function formValue (s) {
  return encodeURIComponent(wellFormed(s)).replace(/%20/g, '+').replace(/[!'()~]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}

/** The query of a track (no host): track_name, artist_name, album_name, duration as LRCLIB takes them. */
export function queryOf (t) {
  let q = 'track_name=' + formValue(t.title) + '&artist_name=' + formValue(t.artist)
  if (typeof t.album === 'string' && t.album !== '' && t.album !== UNKNOWN_ALBUM) q += '&album_name=' + formValue(t.album)
  const seconds = Math.round(t.duration)
  if (seconds <= 3600) q += '&duration=' + formValue(String(seconds))
  return '/api/get?' + q
}

/** Retry-After as a wait in ms (seconds or an HTTP date), or null when absent or unreadable. */
export function retryAfterMs (value, now = Date.now()) {
  if (typeof value !== 'string' || value.trim() === '') return null
  const v = value.trim()
  if (/^\d{1,10}$/.test(v)) return Math.min(Number(v) * 1000, MAX_RETRY_AFTER_MS)
  const at = Date.parse(v)
  if (!Number.isFinite(at)) return null
  return Math.min(Math.max(0, at - now), MAX_RETRY_AFTER_MS)
}
