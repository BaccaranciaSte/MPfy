// Details from the network: a track's missing title, artist, album and cover
// (with album artist, year, track and disc riding along) from AcoustID,
// MusicBrainz and the Cover Art Archive, asked by the source about its own
// tracks, behind the owner's switch ("details" in source.json).
//
// - Missing: a field the file has no tag for (`tagless`), never changed by a
//   person (`edited`), still empty (artist "Artista sconosciuto", album "Album
//   sconosciuto", no cover...). Only a missing title, artist, album or cover
//   starts a lookup. A track from before (`editedUnknown`) gets its title only
//   when it is a junk name like "traccia02".
// - AcoustID with the compressed fingerprint (made from the raw one fpcalc gave
//   at upload); one plausible recording at 0.85 or more, else name evidence.
//   No candidate at all: a MusicBrainz text search on the title (and artist)
//   hints, exact and unambiguous only.
// - MusicBrainz: the recording, its release (official first, the album tag when
//   there is one, else album over EP over single over the rest, then the
//   earliest), the cover from the release, then its release group, 500 px.
// - One worker, its own queue: uploads first, then the background fill in
//   library order, 60 s after start (and at once when the switch turns on).
//   Each service is paced (AcoustID 3 per second, MusicBrainz and CAA one per
//   second) and backs off on 429/503. A failed lookup is tried again after 6 h,
//   12 h, 24 h (4 tries) while a field it may write is missing; anything else is
//   final for that file. When the network gives no answer at all, nothing is
//   written: the queue waits and goes on.
// - What leaves the source: the fingerprint and duration, MusicBrainz ids and,
//   in a text search, the title and artist hints. Never a profile, a device, a
//   path or the source's name.

import path from 'node:path'
import { albumIdOf, isCoverId } from './ids.mjs'
import { saveCoverBytes, sniffImage, MAX_COVER_BYTES, UNKNOWN_ARTIST, UNKNOWN_ALBUM, TAGLESS_FIELDS } from './media.mjs'
import { writeJsonAtomicSync, readJsonFile, log, logError } from './util.mjs'
import { differentVersions } from './versions.mjs'
import { splitGenres } from '../web/js/genres.js'

// The source's own AcoustID application key (not a secret).
export const ACOUSTID_KEY = 'hGPpwA4BVI'
export const ACOUSTID_KEY_RE = /^[A-Za-z0-9]{6,64}$/
export const DETAILS_URLS = Object.freeze({
  acoustid: 'https://api.acoustid.org',
  musicbrainz: 'https://musicbrainz.org',
  caa: 'https://coverartarchive.org'
})
// At least this long between two request starts, per service (ms).
export const PACE = Object.freeze({ acoustid: 334, musicbrainz: 1000, caa: 1000 })
export const PRIORITY = { UPLOAD: 0, BACKGROUND: 1 }

const REQUEST_TIMEOUT = 20000
const BODY_CAP = { acoustid: 1024 * 1024, musicbrainz: 4 * 1024 * 1024, caa: MAX_COVER_BYTES }
const BACKOFF = [5000, 10000, 20000, 40000, 60000]
const THROTTLED_FAIL = 3
const FILL_DELAY_MS = 60000
const POLL_MS = 10000
const RETRY_BASE_MS = 6 * 3600 * 1000
const MAX_TRIES = 4
// No service reachable (no network): the lookup waits, doubling to 30 min.
const OFFLINE_PAUSE = [60000, 120000, 240000, 480000, 960000, 1800000]
const CAA_KEEP = 2000
const LOOKUP_FIELDS = ['title', 'artist', 'album', 'cover']
const RELEASE_PAGE = 100
const RELEASE_PAGES = 3

// ------------------------------------------------------------- fingerprint

function pack (values, bits) {
  const out = Buffer.alloc(Math.ceil((values.length * bits) / 8))
  const mask = (1 << bits) - 1
  let acc = 0
  let n = 0
  let o = 0
  for (const v of values) {
    acc |= (v & mask) << n
    n += bits
    while (n >= 8) {
      out[o++] = acc & 0xff
      acc >>>= 8
      n -= 8
    }
  }
  if (n > 0) out[o] = acc & 0xff
  return out
}

/**
 * The compressed fingerprint AcoustID takes, from fpcalc's raw items (chromaprint's
 * fingerprint_compressor): the algorithm byte, the item count (24 bits, big
 * endian), each item XORed with the previous one written as the gaps between its
 * set bits (3 bits each, 7 and more as 7 plus the rest in a 5-bit list), a 0
 * closing each item; base64url without padding.
 */
export function compressFingerprint (items, algorithm = 1) {
  const normal = []
  const exceptional = []
  for (let i = 0; i < items.length; i++) {
    let x = (i === 0 ? items[0] : items[i] ^ items[i - 1]) >>> 0
    let bit = 1
    let last = 0
    while (x !== 0) {
      if ((x & 1) !== 0) {
        const gap = bit - last
        if (gap >= 7) {
          normal.push(7)
          exceptional.push(gap - 7)
        } else {
          normal.push(gap)
        }
        last = bit
      }
      x >>>= 1
      bit++
    }
    normal.push(0)
  }
  const n = items.length
  const head = Buffer.from([algorithm & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff])
  return Buffer.concat([head, pack(normal, 3), pack(exceptional, 5)]).toString('base64url')
}

// -------------------------------------------------------------------- text

const BRACKETS = /\([^)]*\)|\[[^\]]*\]|【[^】]*】|（[^）]*）/g
const FEAT_TAIL = /\s(?:feat|ft)\.\s.*$/s

/**
 * A text reduced for comparing: NFKC, lowercase, bracketed parts and a
 * " feat. ..." tail removed, then only letters and digits.
 */
export function norm (s) {
  let t = String(s || '').normalize('NFKC').toLowerCase()
  t = t.replace(BRACKETS, ' ')
  t = t.replace(FEAT_TAIL, '')
  return t.replace(/[^\p{L}\p{N}]/gu, '')
}

// The words of a text as norm() sees it (their letters and digits joined are norm()).
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

// A store's mark on an album title: "7 - EP", "Disco - Single", "Disco (Single)".
const STORE_SUFFIX = /\s+[-\u2013\u2014]\s+(?:ep|single|maxi[\s-]?single)\s*$|\s*[(\[](?:ep|single|maxi[\s-]?single)[)\]]\s*$/i
// What may follow an album's title in the title of one of its editions.
const EDITION_WORDS = new Set([
  'deluxe', 'edition', 'expanded', 'remaster', 'remastered', 'anniversary', 'version', 'special', 'bonus', 'track', 'tracks',
  'ep', 'single', 'digital'
])
const editionWord = (w) => EDITION_WORDS.has(w) || /^(?:19|20)\d\d$/.test(w) || /^\d+(?:st|nd|rd|th)$/.test(w)

function albumOf (s) {
  const text = String(s || '').normalize('NFKC').toLowerCase().trim().replace(STORE_SUFFIX, '').trim()
  return { text, words: wordsOf(text) }
}

/**
 * Two album titles are the same title: equal as norm() sees them, a store's
 * " - EP" or " - Single" aside; a title norm() reduces to nothing ("÷", "( )")
 * as it is written.
 */
export function sameAlbum (a, b) {
  const x = albumOf(a)
  const y = albumOf(b)
  if (x.words.length === 0 || y.words.length === 0) return x.words.length === y.words.length && x.text !== '' && x.text === y.text
  return x.words.join('') === y.words.join('')
}

/**
 * Two album titles name one album: the same title, or one is the other and
 * then only edition words ("Disco Deluxe Edition", "Abbey Road - Remastered
 * 2009"). Word by word: "Live" is not "Alive", "Greatest Hits" is not "Greatest
 * Hits Vol. 2", and a title written without spaces matches only whole.
 */
export function albumsMatch (a, b) {
  if (sameAlbum(a, b)) return true
  const x = albumOf(a).words
  const y = albumOf(b).words
  if (x.length === 0 || y.length === 0) return false
  return editionOf(x, y) || editionOf(y, x)
}

// `long` is the words of `short` (as letters) and then only edition words.
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
 * the artist when it has one (or a person typed it). A title that is the track's
 * own id (a file with no title and no name) is never a hint.
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

function positive (v) {
  return Number.isInteger(v) && v > 0 ? v : null
}

// ------------------------------------------------------------------ missing

/**
 * The fields a lookup may write on this track. `values`: what this lookup found
 * (album artist and disc ride along with a filled album and track, the cover
 * looks at the album the track will have); null: before the lookup.
 */
export function missingFields (t, values = null, hasCustomCover = () => false) {
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
  if (open('cover') && t.coverId === null && !hasCustomCover('track', t.id)) {
    const after = {
      artist: out.includes('artist') && fills('artist') ? values.artist : t.artist,
      albumArtist: out.includes('albumArtist') && fills('albumArtist') ? values.albumArtist : t.albumArtist,
      album: album && fills('album') ? values.album : t.album
    }
    if (!hasCustomCover('album', albumIdOf(after))) out.push('cover')
  }
  return out
}

// ---------------------------------------------------------------- genres

const MB_GENRES = 3

/** The genres MusicBrainz gives an entity: the most voted first (none with no vote), at most 3, cleaned. */
export function mbGenres (entity) {
  const list = entity && Array.isArray(entity.genres) ? entity.genres : []
  const voted = list
    .filter((g) => g && typeof g.name === 'string' && !(typeof g.count === 'number' && g.count <= 0))
    .sort((a, b) => (b.count || 0) - (a.count || 0) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return splitGenres(voted.slice(0, 2 * MB_GENRES).map((g) => g.name)).slice(0, MB_GENRES)
}

/** A track whose tags were read and have no genre: its genres are asked of MusicBrainz. */
export function wantsGenres (t) {
  return Array.isArray(t.genres) && t.genres.length === 0
}

/** Does this track start a lookup (a title, artist, album or cover missing)? */
export function wantsLookup (t, hasCustomCover = () => false) {
  return missingFields(t, null, hasCustomCover).some((f) => LOOKUP_FIELDS.includes(f))
}

// ---------------------------------------------------------------- AcoustID

/**
 * The recordings of an AcoustID answer worth considering: from results scoring
 * 0.5 or more, with a title and an artist, merged by id (the highest score, the
 * sum of the sources).
 */
export function acoustidCandidates (answer) {
  const byId = new Map()
  const results = answer && Array.isArray(answer.results) ? answer.results : []
  for (const r of results) {
    if (!r || typeof r.score !== 'number' || r.score < 0.5) continue
    for (const rec of Array.isArray(r.recordings) ? r.recordings : []) {
      if (!rec || typeof rec.id !== 'string' || typeof rec.title !== 'string' || rec.title === '') continue
      if (!Array.isArray(rec.artists) || rec.artists.length === 0) continue
      const sources = typeof rec.sources === 'number' && Number.isFinite(rec.sources) ? rec.sources : 0
      const c = byId.get(rec.id)
      if (c === undefined) {
        byId.set(rec.id, {
          id: rec.id,
          title: rec.title,
          artist: artistText(rec.artists),
          duration: typeof rec.duration === 'number' ? rec.duration : null,
          score: r.score,
          sources,
          acoustid: typeof r.id === 'string' ? r.id : null
        })
      } else {
        if (r.score > c.score) {
          c.score = r.score
          c.acoustid = typeof r.id === 'string' ? r.id : c.acoustid
        }
        c.sources += sources
      }
    }
  }
  return [...byId.values()]
}

/**
 * Which recording: { kind: 'take', candidate, rule } | { kind: 'ambiguous' } |
 * { kind: 'none' } (no candidate: the text search follows).
 */
export function chooseRecording (cands, { duration, hints }) {
  if (cands.length === 0) return { kind: 'none' }
  const durOk = (c) => typeof c.duration === 'number' && typeof duration === 'number' && Math.abs(c.duration - duration) <= 3
  // 1. A sure match: one plausible recording among those at 0.85 or more.
  if (Math.max(...cands.map((c) => c.score)) >= 0.85) {
    const high = cands.filter((c) => c.score >= 0.85 && durOk(c))
    if (high.length > 0) {
      const top = Math.max(...high.map((c) => c.sources))
      const plausible = high.filter((c) => c.sources >= 0.25 * top)
      if (plausible.length === 1) return { kind: 'take', candidate: plausible[0], rule: 1 }
    }
  }
  // 2. Name evidence: the title hint (and the artist one) match, and both name
  // the same version ("夜に駆ける (instrumental)" is not "夜に駆ける").
  if (hints.usable) {
    const title = norm(hints.title)
    const artist = hints.artist ? norm(hints.artist) : null
    const named = cands.filter((c) => durOk(c) && textsMatch(norm(c.title), title) && !differentVersions(c.title, hints.title) &&
      (artist === null || textsMatch(norm(c.artist), artist)))
    if (named.length > 0) {
      const best = named.map((c, i) => ({ c, i })).sort((a, b) => b.c.sources - a.c.sources || b.c.score - a.c.score || a.i - b.i)[0].c
      return { kind: 'take', candidate: best, rule: 2 }
    }
  }
  return { kind: 'ambiguous' }
}

// -------------------------------------------------------------- MusicBrainz

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

// The releases titled like the album tag, or in a release group titled so: the
// same title first, else an edition of it.
function namedLike (releases, albumHint) {
  const fits = (r, match) => match(r.title, albumHint) || (groupTitleOf(r) !== null && match(groupTitleOf(r), albumHint))
  const same = releases.filter((r) => fits(r, sameAlbum))
  return same.length > 0 ? same : releases.filter((r) => fits(r, albumsMatch))
}

/**
 * The release of a recording: official first (the others only when none is),
 * the one titled like the album tag when there is one (among them all: a
 * pseudo-release with a romanized or translated title stands for the official
 * releases of its group), else the lowest rank, then the earliest date (none
 * last), then the smallest id.
 */
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

/**
 * Is this the album the file names? With no album tag any release is. Else
 * their titles match ("Disco - Single" and "Disco (Deluxe)" are "Disco"), or
 * its release group's, or that of a release of its group in `releases` (the
 * romanized "Yoru ni Kakeru" names the single 夜に駆ける): a release of another
 * album must give the track nothing of its own (year, track, disc, cover).
 */
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
      v.trackNo = track ? positive(track.position) : null
      v.discNo = medium ? positive(medium.position) : null
    }
  }
  return v
}

/** The disc and track of a recording on a release (a release lookup with recordings). */
export function positionsOf (release, recordingId) {
  for (const medium of Array.isArray(release && release.media) ? release.media : []) {
    for (const track of Array.isArray(medium.tracks) ? medium.tracks : []) {
      if (track && track.recording && track.recording.id === recordingId) {
        return { trackNo: positive(track.position), discNo: positive(medium.position) }
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

/**
 * The recording of a text search, or null: score 90 or more, length within 3 s,
 * the exact normalized title naming the same version, the artist hint matched;
 * exactly one artist credit among them, the highest score.
 */
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

// ------------------------------------------------------------------- HTTP

class LookupFailed extends Error {}
class Stopped extends Error {}
// Not even the first request of a lookup got an answer: the network, not the track.
class Offline extends Error {}

// One per service: a request starts at least `interval` ms after the previous
// one started AND after its answer came (so the service sees them that far
// apart, whatever a fresh connection's handshake cost the first), and a pause
// after a 429 or 503 (5 s, doubling to 60 s, until a normal answer).
class Pacer {
  constructor (interval, backoff = BACKOFF) {
    this.interval = interval
    this.backoff = backoff
    this.last = 0
    this.pauseUntil = 0
    this.level = 0
    this._tail = Promise.resolve()
  }

  slot () {
    const turn = this._tail.then(async () => {
      const wait = Math.max(this.last + this.interval, this.pauseUntil) - Date.now()
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait).unref())
      this.last = Date.now()
    })
    this._tail = turn.catch(() => {})
    return turn
  }

  /** The answer came (or the request failed): the next one counts from now. */
  done () {
    this.last = Date.now()
  }

  throttled () {
    this.pauseUntil = Date.now() + this.backoff[Math.min(this.level, this.backoff.length - 1)]
    this.level++
  }

  calm () {
    this.level = 0
  }
}

// The body, or null past the cap (the rest is not read).
async function readCapped (res, cap) {
  const chunks = []
  let total = 0
  if (res.body) {
    for await (const chunk of res.body) {
      total += chunk.length
      if (total > cap) return null
      chunks.push(Buffer.from(chunk))
    }
  }
  return Buffer.concat(chunks, total)
}

function parseJson (buf) {
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch {
    throw new LookupFailed('answer is not JSON')
  }
}

// ------------------------------------------------------------------ worker

export class Details {
  /**
   * @param {object} deps
   * @param {import('./library.mjs').Library} deps.library
   * @param {import('./source.mjs').SourceStore} deps.source
   * @param {import('./fingerprint.mjs').Fingerprints} deps.fingerprints
   * @param {string} deps.dataDir
   * @param {{ acoustid, musicbrainz, caa }|null} deps.urls  null: no lookups at all
   * @param {string} deps.userAgent
   * @param {(coverId: string) => void} [deps.onCover]  a cover was set (its sizes)
   * @param {number} [deps.fillDelayMs]
   * @param {object} [deps.pace]
   * @param {number} [deps.pollMs]  how often source.json is looked at
   * @param {() => number} [deps.now]  the clock of the lookup records (tests)
   * @param {number[]} [deps.backoff]  the pauses after a 429 or 503 (tests)
   * @param {number} [deps.retryBaseMs]  the first wait before a failed lookup is tried again (tests)
   * @param {number[]} [deps.offlinePause]  the waits while no service answers (tests)
   */
  constructor ({ library, source, fingerprints, dataDir, urls, userAgent, onCover = () => {}, fillDelayMs = FILL_DELAY_MS, pace = PACE, pollMs = POLL_MS, now = Date.now, backoff = BACKOFF, retryBaseMs = RETRY_BASE_MS, offlinePause = OFFLINE_PAUSE, genres = true }) {
    this.library = library
    this.source = source
    this.fingerprints = fingerprints
    this.urls = urls
    this.userAgent = userAgent
    this.onCover = onCover
    this.fillDelayMs = fillDelayMs
    this.pollMs = pollMs
    this.now = now
    this.retryBaseMs = retryBaseMs
    this.offlinePause = offlinePause
    // The genres of the tracks whose tags have none: asked by text (title, artist, album), never
    // with a fingerprint; the genres of an album and of an artist asked once.
    this.genresOn = genres
    this._rgGenres = new Map()
    this._artistGenres = new Map()
    this.file = path.join(path.resolve(dataDir), 'details.json')
    this.pacers = { acoustid: new Pacer(pace.acoustid, backoff), musicbrainz: new Pacer(pace.musicbrainz, backoff), caa: new Pacer(pace.caa, backoff) }
    this.stats = { requests: 0, lookups: 0 }

    this._caa = new Map() // release mbid -> { coverId, at }
    this._queue = [] // { id, priority, seq }
    this._queued = new Map()
    this._seq = 0
    this._running = null
    this._open = false // the background part of the queue runs
    this._enabled = false
    this._key = null
    this._keyStopped = false
    this._timers = new Set()
    this._retryTimer = null
    this._retryAt = Infinity
    this._offlineUntil = 0
    this._offlineLevel = 0
    this._abort = null
    this._idleWaiters = []
    this._closed = false
    this._started = false
    // Another file of a track brought an album over the one the network filled.
    library.onStaleLookup = (id) => this.request(id)
  }

  get active () {
    return this.urls !== null && !this._closed
  }

  /** Read details.json, look at the switch, plan the fill. */
  start () {
    const data = readJsonFile(this.file)
    if (data && data.schema === 1 && data.caa && typeof data.caa === 'object') {
      for (const [id, e] of Object.entries(data.caa)) {
        if (!/^[0-9a-f-]{36}$/.test(id) || !e || typeof e !== 'object' || !Number.isFinite(e.at)) continue
        this._caa.set(id, { coverId: isCoverId(e.coverId) ? e.coverId : null, at: e.at })
      }
    }
    this._started = true
    const d = this.source.data
    this._enabled = d.details !== false
    this._key = d.acoustidKey || null
    if (!this.active) return
    this._later(() => {
      this._open = true
      this.fill()
    }, this.fillDelayMs)
    const poll = setInterval(() => this.sourceChanged(), this.pollMs)
    poll.unref()
    this._timers.add(poll)
  }

  _later (fn, ms) {
    const timer = setTimeout(() => {
      this._timers.delete(timer)
      if (!this._closed) fn()
    }, Math.min(ms, 2 ** 31 - 1))
    timer.unref()
    this._timers.add(timer)
    return timer
  }

  /** source.json may have changed (a PATCH, the CLI, an edit by hand). */
  sourceChanged () {
    if (!this._started) return
    const d = this.source.data
    const key = d.acoustidKey || null
    if (key !== this._key) {
      this._key = key
      if (this._keyStopped) log('details: AcoustID key changed, AcoustID asked again')
      this._keyStopped = false
    }
    const enabled = d.details !== false
    if (enabled === this._enabled) return
    this._enabled = enabled
    if (!enabled) {
      this._queue = []
      this._queued.clear()
      if (this._abort !== null) this._abort.abort()
      log('details: off')
      return
    }
    log('details: on')
    if (!this.active) return
    this._open = true
    this.fill()
  }

  get enabled () {
    return this._enabled
  }

  get acoustidKey () {
    return this._key || ACOUSTID_KEY
  }

  _hasCustomCover () {
    return (kind, id) => this.library.hasCustomCover(kind, id)
  }

  // When a failed lookup may run again (null: never).
  _retryDue (l) {
    if (l.state !== 'failed' || l.tries >= MAX_TRIES) return null
    return l.at + this.retryBaseMs * 2 ** (l.tries - 1)
  }

  // Any field a lookup may write is missing (a year, a track number included).
  _missing (t) {
    return missingFields(t, null, this._hasCustomCover()).length > 0
  }

  /** Should this track be looked up now (for its missing fields, or for its genres)? */
  due (t) {
    return this._mainDue(t) || this._genresDue(t)
  }

  // Its genres: tags with none, and no answer for this file yet (a failed one: in its time).
  _genresDue (t) {
    if (!this.genresOn || !wantsGenres(t)) return false
    const g = t.genreLookup
    if (!g || g.fileHash !== t.fileHash) return true
    const at = this._genresRetryDue(g)
    return at !== null && this.now() >= at
  }

  _genresRetryDue (g) {
    if (g.state !== 'failed' || g.tries >= MAX_TRIES) return null
    return g.at + this.retryBaseMs * 2 ** (g.tries - 1)
  }

  _mainDue (t) {
    const l = t.lookup
    // Its album changed (`stale`, library.mjs): looked up again for whatever is missing.
    if (l && l.stale === true) return this._missing(t)
    if (!l || l.fileHash !== t.fileHash) return wantsLookup(t, this._hasCustomCover())
    // A failed lookup goes on for what it may still write: after an album change
    // that can be only the year or the track.
    const at = this._retryDue(l)
    return at !== null && this.now() >= at && this._missing(t)
  }

  /** An upload (a new track, a replaced file): looked up first. */
  request (trackId, priority = PRIORITY.UPLOAD) {
    if (!this.active || !this._enabled) return
    const t = this.library.getTrack(trackId)
    if (t === null || !this.due(t)) return
    this._enqueue(trackId, priority)
  }

  /** The background fill: every track that is due, in library order. */
  fill () {
    if (!this.active || !this._enabled) return
    let next = Infinity
    for (const t of this.library.tracks.values()) {
      if (t.tagless === null) continue // the tags job sets it, then asks
      if (this.due(t)) {
        this._enqueue(t.id, PRIORITY.BACKGROUND)
        continue
      }
      const l = t.lookup
      const at = l && l.fileHash === t.fileHash ? this._retryDue(l) : null
      if (at !== null && this._missing(t)) next = Math.min(next, at)
      const g = this.genresOn && wantsGenres(t) && t.genreLookup && t.genreLookup.fileHash === t.fileHash ? this._genresRetryDue(t.genreLookup) : null
      if (g !== null) next = Math.min(next, g)
    }
    this._scheduleRetry(next)
    this._pump()
  }

  // A fill when the earliest failed lookup is due again (one timer, the earliest wins).
  _scheduleRetry (at) {
    if (at === Infinity || !this.active || !this._enabled) return
    if (this._retryTimer !== null) {
      if (this._retryAt <= at) return
      clearTimeout(this._retryTimer)
      this._timers.delete(this._retryTimer)
    }
    this._retryAt = at
    this._retryTimer = this._later(() => {
      this._retryTimer = null
      this._retryAt = Infinity
      this.fill()
    }, Math.max(1000, at - this.now()))
  }

  _enqueue (id, priority) {
    const queued = this._queued.get(id)
    if (queued) {
      if (priority < queued.priority) queued.priority = priority
    } else {
      const job = { id, priority, seq: this._seq++ }
      this._queue.push(job)
      this._queued.set(id, job)
    }
    this._pump()
  }

  _next () {
    let best = -1
    for (let i = 0; i < this._queue.length; i++) {
      const a = this._queue[i]
      if (a.priority === PRIORITY.BACKGROUND && !this._open) continue
      const b = best === -1 ? null : this._queue[best]
      if (b === null || a.priority < b.priority || (a.priority === b.priority && a.seq < b.seq)) best = i
    }
    if (best === -1) return null
    const job = this._queue.splice(best, 1)[0]
    this._queued.delete(job.id)
    return job
  }

  _pump () {
    if (this._closed || this._running !== null) return
    const job = this._enabled && !this._offline() ? this._next() : null
    if (job === null) {
      const waiters = this._idleWaiters
      this._idleWaiters = []
      for (const resolve of waiters) resolve()
      return
    }
    this._running = job
    this._run(job)
      .catch((err) => logError('details of ' + job.id + ' crashed: ' + (err && err.stack ? err.stack : err)))
      .finally(() => {
        this._running = null
        setImmediate(() => this._pump())
      })
  }

  _offline () {
    return Date.now() < this._offlineUntil
  }

  // No service answered: the job goes back to its place, nothing is written and
  // no try is counted; the queue waits (1 min, doubling to 30 min) and goes on.
  _wait (job) {
    const queued = this._queued.get(job.id)
    if (queued) {
      queued.priority = Math.min(queued.priority, job.priority)
      queued.seq = Math.min(queued.seq, job.seq)
    } else {
      this._queue.push(job)
      this._queued.set(job.id, job)
    }
    const pause = this.offlinePause[Math.min(this._offlineLevel, this.offlinePause.length - 1)]
    if (this._offlineLevel === 0) log('details: no answer from the network, lookups wait')
    this._offlineLevel++
    this._offlineUntil = Date.now() + pause
    this._later(() => this._pump(), pause)
  }

  /** Resolves when nothing runs and nothing queued may run now. */
  idle () {
    if (this._closed) return Promise.resolve()
    const runnable = this._enabled && !this._offline() && this._queue.some((j) => j.priority === PRIORITY.UPLOAD || this._open)
    if (this._running === null && !runnable) return Promise.resolve()
    return new Promise((resolve) => this._idleWaiters.push(resolve))
  }

  get queued () {
    return this._queue.length
  }

  // --------------------------------------------------------------- lookup

  async _run (job) {
    const id = job.id
    const track = this.library.getTrack(id)
    if (track === null || !this._enabled) return
    if (!this._mainDue(track)) {
      if (this._genresDue(track)) await this._runGenres(job, track)
      return
    }
    this.stats.lookups++
    const started = track.lookup
    const previous = started && started.fileHash === track.fileHash && started.stale !== true ? started : null
    const tries = previous !== null && previous.state === 'failed' ? previous.tries + 1 : 1
    // The album the answer is for (another file of the track, or a person, may change it meanwhile).
    const album = track.album
    let result
    this._abort = new AbortController()
    const ctx = { throttled: 0, signal: this._abort.signal, answered: false, keySkipped: false }
    try {
      result = await this._lookup(track, album, ctx)
    } catch (err) {
      if (err instanceof Stopped || this._closed || !this._enabled) return
      if (err instanceof Offline) return this._wait(job)
      if (!(err instanceof LookupFailed)) logError('details of ' + id + ': ' + (err && err.message))
      result = { state: 'failed', acoustid: ctx.acoustid || null, recording: ctx.recording || null, release: null, values: null, coverId: null }
    } finally {
      this._abort = null
    }
    this._finish(track, result, tries, album)
  }

  // Written once per attempt, on the track as it is now, only its missing fields.
  _finish (track, result, tries, album) {
    const now = this.library.getTrack(track.id)
    if (now === null || now.fileHash !== track.fileHash) {
      if (result.coverId) this.library.dropCoverIfUnused(result.coverId)
      return
    }
    // Its album changed while this ran: the answer is for the album it had. Again.
    if (now.album !== album) {
      if (result.coverId) this.library.dropCoverIfUnused(result.coverId)
      this.request(now.id)
      return
    }
    const values = result.values ? { ...result.values, cover: result.coverId || null } : null
    const missing = values === null ? [] : missingFields(now, values, this._hasCustomCover())
    const next = { ...now }
    const found = []
    for (const f of TAGLESS_FIELDS) {
      if (!missing.includes(f) || values[f] === null || values[f] === undefined || values[f] === '') continue
      if (f === 'cover') next.coverId = values.cover
      else next[f] = values[f]
      found.push(f)
    }
    // What an earlier lookup filled stays the network's while nothing replaced
    // it (still tagless, never edited): a failed try never shrinks the list.
    const before = now.lookup && Array.isArray(now.lookup.filled) ? now.lookup.filled : []
    const edited = Array.isArray(now.edited) ? now.edited : []
    const open = (f) => Array.isArray(now.tagless) && now.tagless.includes(f) && !edited.includes(f)
    const filled = TAGLESS_FIELDS.filter((f) => found.includes(f) || (before.includes(f) && open(f)))
    next.lookup = {
      v: 1,
      state: result.state,
      at: this.now(),
      tries,
      fileHash: now.fileHash,
      acoustid: result.acoustid || null,
      recording: result.recording || null,
      release: result.release || null,
      filled
    }
    // The genres the recording's answer brought (only for a track whose tags have none).
    if (Array.isArray(result.genres)) next.genreLookup = { v: 1, state: 'done', at: this.now(), tries: 1, fileHash: now.fileHash, genres: result.genres }
    this.library.setTrack(next)
    if (this._genresDue(next)) this._enqueue(next.id, PRIORITY.BACKGROUND)
    if (found.includes('cover')) this.onCover(values.cover)
    else if (result.coverId) this.library.dropCoverIfUnused(result.coverId)
    const retry = this._retryDue(next.lookup)
    if (retry !== null) this._scheduleRetry(retry)
  }

  async _lookup (track, album, ctx) {
    const hints = hintsOf(track)
    const albumHint = album && album !== UNKNOWN_ALBUM ? album : null
    let recordingId = null
    // AcoustID, with the fingerprint. While it refuses the key, what the text
    // search cannot find is not final: AcoustID is asked on a later try.
    if (this._keyStopped) {
      ctx.keySkipped = track.fpState === 'ok' || (this.fingerprints.available && this.fingerprints.runner !== null)
    } else {
      const fp = await this._fingerprintOf(track)
      if (fp !== null) {
        const answer = await this._acoustid(fp, track, ctx)
        if (answer === null) ctx.keySkipped = true
        if (answer !== null) {
          const cands = acoustidCandidates(answer)
          const pick = chooseRecording(cands, { duration: typeof track.duration === 'number' ? track.duration : fp.duration, hints })
          if (pick.kind === 'ambiguous') {
            const top = cands.slice().sort((a, b) => b.score - a.score)[0]
            return { state: 'ambiguous', acoustid: top ? top.acoustid : null, recording: null, release: null, values: null, coverId: null }
          }
          if (pick.kind === 'take') {
            recordingId = pick.candidate.id
            ctx.acoustid = pick.candidate.acoustid
          }
        }
      }
    }
    // No candidate: the text search, with a name worth sending.
    if (recordingId === null) {
      const ms = typeof track.duration === 'number' ? Math.round(track.duration * 1000) : null
      if (!hints.usable || ms === null) return this._nothing(ctx)
      const query = searchQuery(hints, ms)
      const answer = await this._mb('/ws/2/recording?query=' + encodeURIComponent(query) + '&fmt=json&limit=10', ctx)
      const found = answer === null ? null : chooseFromSearch(answer, hints, ms)
      if (found === null) return this._nothing(ctx)
      recordingId = found.id
    }
    ctx.recording = recordingId
    // The recording and its release.
    const withGenres = this.genresOn && wantsGenres(track)
    const recording = await this._mb('/ws/2/recording/' + encodeURIComponent(recordingId) + '?inc=releases+release-groups+media+artist-credits' + (withGenres ? '+genres' : '') + '&fmt=json', ctx)
    if (recording === null) return this._nothing(ctx)
    const releases = Array.isArray(recording.releases) ? recording.releases : []
    let release = null
    let positions = null
    if (releases.length === 25) {
      // A lookup lists 25 releases at most: choose among all of them, the
      // official ones first; every status when none of those is the album.
      let list = await this._browse(recordingId, true, ctx)
      release = chooseRelease(list, albumHint)
      if (release === null || !releaseFits(release, albumHint, list)) {
        list = await this._browse(recordingId, false, ctx)
        release = chooseRelease(list, albumHint)
      }
      if (!releaseFits(release, albumHint, list)) release = null
      if (release !== null) {
        const full = await this._mb('/ws/2/release/' + encodeURIComponent(release.id) + '?inc=recordings&fmt=json', ctx)
        positions = full === null ? { trackNo: null, discNo: null } : positionsOf(full, recordingId)
      }
    } else {
      release = chooseRelease(releases, albumHint)
      if (!releaseFits(release, albumHint, releases)) release = null
    }
    const values = valuesOf(recording, release, positions)
    const found = { acoustid: ctx.acoustid || null, recording: recordingId, release: release ? release.id : null, values }
    if (withGenres) {
      try {
        found.genres = await this._genresFor(recording, release, ctx)
      } catch (err) {
        // The album's or the artist's genres failed: the genres lookup asks again on its own.
        if (!(err instanceof LookupFailed)) throw err
      }
    }
    let coverId = null
    if (release !== null && missingFields(track, values, this._hasCustomCover()).includes('cover')) {
      const rg = release['release-group'] && typeof release['release-group'].id === 'string' ? release['release-group'].id : null
      try {
        coverId = await this._cover(release.id, rg, ctx)
      } catch (err) {
        // The cover archive failed: what the databases gave is written now, the cover comes on a later try.
        if (!(err instanceof LookupFailed)) throw err
        return { state: 'failed', ...found, coverId: null }
      }
    }
    return { state: 'applied', ...found, coverId }
  }

  _nothing (ctx) {
    return { state: ctx.keySkipped ? 'failed' : 'nothing', acoustid: ctx.acoustid || null, recording: null, release: null, values: null, coverId: null }
  }

  // The genres of a track whose tags have none: written as `genreLookup` (done, or failed and
  // tried again in its time like a lookup). Nothing else of the track changes.
  async _runGenres (job, track) {
    this.stats.genres = (this.stats.genres || 0) + 1
    const prev = track.genreLookup && track.genreLookup.fileHash === track.fileHash ? track.genreLookup : null
    const tries = prev !== null && prev.state === 'failed' ? prev.tries + 1 : 1
    this._abort = new AbortController()
    const ctx = { throttled: 0, signal: this._abort.signal, answered: false, keySkipped: false }
    let state = 'done'
    let genres = []
    try {
      genres = await this._lookupGenres(track, ctx)
    } catch (err) {
      if (err instanceof Stopped || this._closed || !this._enabled) return
      if (err instanceof Offline) return this._wait(job)
      if (!(err instanceof LookupFailed)) logError('genres of ' + track.id + ': ' + (err && err.message))
      state = 'failed'
      genres = []
    } finally {
      this._abort = null
    }
    const now = this.library.getTrack(track.id)
    if (now === null || now.fileHash !== track.fileHash || !wantsGenres(now)) return
    const g = { v: 1, state, at: this.now(), tries, fileHash: now.fileHash, genres }
    this.library.setTrack({ ...now, genreLookup: g })
    const retry = this._genresRetryDue(g)
    if (retry !== null) this._scheduleRetry(retry)
  }

  // The recording: the one a lookup found, else the text search (title, artist, album). No
  // fingerprint leaves for the genres.
  async _lookupGenres (track, ctx) {
    const l = track.lookup
    let recordingId = l && l.fileHash === track.fileHash && typeof l.recording === 'string' ? l.recording : null
    const albumHint = track.album && track.album !== UNKNOWN_ALBUM ? track.album : null
    if (recordingId === null) {
      const hints = hintsOf(track)
      const ms = typeof track.duration === 'number' ? Math.round(track.duration * 1000) : null
      if (!hints.usable || ms === null) return []
      const answer = await this._mb('/ws/2/recording?query=' + encodeURIComponent(searchQuery(hints, ms)) + '&fmt=json&limit=10', ctx)
      const found = answer === null ? null : chooseFromSearch(answer, hints, ms)
      if (found === null) return []
      recordingId = found.id
    }
    const recording = await this._mb('/ws/2/recording/' + encodeURIComponent(recordingId) + '?inc=genres+releases+release-groups+artist-credits&fmt=json', ctx)
    if (recording === null) return []
    const releases = Array.isArray(recording.releases) ? recording.releases : []
    let release = chooseRelease(releases, albumHint)
    if (!releaseFits(release, albumHint, releases)) release = null
    return this._genresFor(recording, release, ctx)
  }

  // The recording's genres, else its album's (the release group), else its first artist's.
  async _genresFor (recording, release, ctx) {
    let g = mbGenres(recording)
    if (g.length > 0) return g
    const rg = release && release['release-group'] && typeof release['release-group'].id === 'string' ? release['release-group'].id : null
    if (rg !== null) {
      g = await this._cachedGenres(this._rgGenres, 'release-group', rg, ctx)
      if (g.length > 0) return g
    }
    const credits = Array.isArray(recording['artist-credit']) ? recording['artist-credit'] : []
    const artist = credits[0] && credits[0].artist && typeof credits[0].artist.id === 'string' ? credits[0].artist.id : null
    return artist === null ? [] : this._cachedGenres(this._artistGenres, 'artist', artist, ctx)
  }

  async _cachedGenres (cache, kind, id, ctx) {
    if (cache.has(id)) return cache.get(id)
    const answer = await this._mb('/ws/2/' + kind + '/' + encodeURIComponent(id) + '?inc=genres&fmt=json', ctx)
    const g = answer === null ? [] : mbGenres(answer)
    if (cache.size >= 5000) cache.clear()
    cache.set(id, g)
    return g
  }

  // The compressed fingerprint: from the raw one stored at upload, else fpcalc.
  async _fingerprintOf (track) {
    const fps = this.fingerprints
    const stored = track.fpState === 'ok' ? fps.read(track.fileHash) : null
    if (stored !== null && stored.items.length > 0) return { duration: stored.duration, fingerprint: compressFingerprint(stored.items) }
    if (!fps.available || fps.runner === null) return null
    try {
      // fpcalc reads an internal file (a card original is copied first).
      const { stdout } = await this.library.withLocalFile(track, (file) => fps.runner.run(['-json', '-length', '120', file], { timeoutMs: 120000, stdout: true, quiet: true }))
      const data = JSON.parse(stdout)
      if (typeof data.fingerprint !== 'string' || !/^[A-Za-z0-9_-]+$/.test(data.fingerprint) || !(data.duration > 0)) return null
      return { duration: data.duration, fingerprint: data.fingerprint }
    } catch {
      return null
    }
  }

  // The AcoustID answer, or null when AcoustID stopped (an invalid key).
  async _acoustid (fp, track, ctx) {
    const duration = Math.round(typeof track.duration === 'number' ? track.duration : fp.duration)
    const body = 'client=' + encodeURIComponent(this.acoustidKey) + '&format=json&meta=recordings+sources&duration=' + duration + '&fingerprint=' + fp.fingerprint
    const res = await this._call('acoustid', this.urls.acoustid + '/v2/lookup', { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, ctx)
    const data = res.body.length > 0 ? parseJson(res.body) : null
    if (data && data.status === 'error' && data.error && data.error.code === 4) {
      if (!this._keyStopped) log('details: AcoustID refuses the key (' + (data.error.message || 'invalid API key') + '), text search only until the key changes')
      this._keyStopped = true
      return null
    }
    if (res.status !== 200 || !data || data.status !== 'ok') throw new LookupFailed('AcoustID answered ' + res.status)
    return data
  }

  // A MusicBrainz answer (JSON), or null for a 404.
  async _mb (pathAndQuery, ctx) {
    const res = await this._call('musicbrainz', this.urls.musicbrainz + pathAndQuery, { headers: { Accept: 'application/json' } }, ctx)
    if (res.status === 404) return null
    if (res.status !== 200) throw new LookupFailed('MusicBrainz answered ' + res.status)
    return parseJson(res.body)
  }

  // Every release of a recording (official ones only, or all), up to 300.
  async _browse (recordingId, official, ctx) {
    const out = []
    for (let page = 0; page < RELEASE_PAGES; page++) {
      const q = '/ws/2/release?recording=' + encodeURIComponent(recordingId) + (official ? '&status=official' : '') +
        '&inc=release-groups+artist-credits&limit=' + RELEASE_PAGE + (page > 0 ? '&offset=' + page * RELEASE_PAGE : '') + '&fmt=json'
      const data = await this._mb(q, ctx)
      const list = data && Array.isArray(data.releases) ? data.releases : []
      out.push(...list)
      const count = data && Number.isInteger(data['release-count']) ? data['release-count'] : 0
      if (count <= (page + 1) * RELEASE_PAGE) break
    }
    return out
  }

  // The front cover of a release (else of its release group), stored as an
  // embedded cover; null when there is none. Each release is asked once.
  async _cover (releaseId, groupId, ctx) {
    const cached = this._caa.get(releaseId)
    if (cached !== undefined && (cached.coverId === null || this.library.coverExists(cached.coverId))) return cached.coverId
    let res = await this._call('caa', this.urls.caa + '/release/' + encodeURIComponent(releaseId) + '/front-500', {}, ctx)
    if (res.status === 404 && groupId !== null) res = await this._call('caa', this.urls.caa + '/release-group/' + encodeURIComponent(groupId) + '/front-500', {}, ctx)
    let coverId = null
    if (res.status === 200) {
      coverId = res.body === null || sniffImage(res.body) === null ? null : saveCoverBytes(res.body, this.library.coversDir)
    } else if (res.status !== 404) {
      throw new LookupFailed('Cover Art Archive answered ' + res.status)
    }
    this._caa.set(releaseId, { coverId, at: this.now() })
    this._saveCaa()
    return coverId
  }

  _saveCaa () {
    if (this._caa.size > CAA_KEEP) {
      const oldest = [...this._caa].sort((a, b) => a[1].at - b[1].at).slice(0, this._caa.size - CAA_KEEP)
      for (const [id] of oldest) this._caa.delete(id)
    }
    try {
      writeJsonAtomicSync(this.file, { schema: 1, caa: Object.fromEntries(this._caa) })
    } catch (err) {
      logError('details.json write failed: ' + err.message)
    }
  }

  // One request, paced, with the backoff on 429 and 503 (3 in a row on one
  // track: it failed).
  async _call (service, url, opts, ctx) {
    const pacer = this.pacers[service]
    for (;;) {
      if (this._closed || !this._enabled) throw new Stopped()
      await pacer.slot()
      if (this._closed || !this._enabled) throw new Stopped()
      let res
      try {
        res = await this._fetch(service, url, opts, ctx)
      } finally {
        pacer.done()
      }
      if (res.status === 429 || res.status === 503) {
        pacer.throttled()
        if (++ctx.throttled >= THROTTLED_FAIL) throw new LookupFailed(service + ' busy')
        continue
      }
      pacer.calm()
      ctx.throttled = 0
      return res
    }
  }

  async _fetch (service, url, { method = 'GET', body = null, headers = {} } = {}, ctx) {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT)
    const signal = ctx.signal ? AbortSignal.any([timeout, ctx.signal]) : timeout
    this.stats.requests++
    try {
      const res = await fetch(url, { method, body, headers: { 'User-Agent': this.userAgent, ...headers }, redirect: 'follow', signal })
      ctx.answered = true
      if (this._offlineLevel > 0) log('details: the network answers again')
      this._offlineLevel = 0
      const data = await readCapped(res, BODY_CAP[service])
      // An image over the cap is no cover; any other answer that big is a failure.
      if (data === null && service !== 'caa') throw new LookupFailed(service + ': answer too large')
      return { status: res.status, body: data }
    } catch (err) {
      if (err instanceof LookupFailed) throw err
      if (ctx.signal && ctx.signal.aborted) throw new Stopped()
      // No connection, no answer in 20 s: the network when nothing answered yet in this lookup.
      if (!ctx.answered) throw new Offline(service + ': ' + (err && err.message))
      throw new LookupFailed(service + ': ' + (err && err.message))
    }
  }

  /** The numbers of /admin/health. */
  health () {
    const counts = { applied: 0, nothing: 0, ambiguous: 0, failed: 0 }
    for (const t of this.library.tracks.values()) if (t.lookup && counts[t.lookup.state] !== undefined) counts[t.lookup.state]++
    return { enabled: this._enabled, queued: this._queue.length, ...counts, acoustidKeyValid: !this._keyStopped }
  }

  close () {
    this._closed = true
    for (const timer of this._timers) {
      clearTimeout(timer)
      clearInterval(timer)
    }
    this._timers.clear()
    if (this._abort !== null) this._abort.abort()
    this._queue = []
    this._queued.clear()
    const waiters = this._idleWaiters
    this._idleWaiters = []
    for (const resolve of waiters) resolve()
  }
}

/** The User-Agent of every request. */
export function userAgentOf (version) {
  return 'MPfy/' + version + ' ( https://github.com/BaccaranciaSte/MPfy )'
}
