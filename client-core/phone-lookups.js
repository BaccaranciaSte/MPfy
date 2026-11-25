// The details and lyrics of the phone's own songs, found by the phone itself with
// the source's rules (phone-rules.js): a missing title, artist, album or cover from
// a MusicBrainz text search and the Cover Art Archive (server/details.mjs, the path
// it takes when AcoustID has no candidate: the phone has no fingerprint), lyrics
// from LRCLIB for a song with nothing from its tags (server/lyrics.mjs).
//
// - The transport is the host's: a request goes out as { t: 'net', id, service,
//   url, kind } ('json' or 'cover') and comes back as { t: 'net-reply', id, status,
//   retryAfter, json | cover | error }. The host sends exactly the source's
//   User-Agent and an Accept, only to these services, and refuses at once
//   (error 'metered') on a metered network or with Data Saver or battery saver on.
// - Two workers, one request at a time each: details (MusicBrainz and the Cover Art
//   Archive, one request every 3 s each, PHONE_PACE) and lyrics (LRCLIB, 1.5 s
//   between starts). 429 and 503 back off as the source does; a failed lookup is
//   tried again later as the source does; no answer at all pauses a worker,
//   doubling from a minute to half an hour, nothing written; a metered refusal
//   pauses it until the network changes (the host's `network` message).
// - Only while the switch "Cerca i dettagli in rete" is on: off, nothing is sent and
//   what is in flight is dropped. A song whose very same file a real source holds
//   (shadowed: the page says which) is never asked about: the source's details and
//   lyrics are what shows. While the page has not said which, with real sources,
//   nothing is asked.
// - No work at rest: an empty queue keeps no timer; a retry hours away is one
//   timer, the earliest. The background fill starts FILL_DELAY_MS after start;
//   songs that come in (new or changed) are asked about first.
//
// Portable: timers, b4a; the rules from phone-rules.js.

import b4a from 'b4a'
import { parseLrc, parsePlain } from './lrc.js'
import {
  hintsOf, searchQuery, chooseFromSearch, chooseRelease, releaseFits, valuesOf, positionsOf, missingFields, wantsLookup,
  keyOf, askable, queryOf, retryAfterMs, Pacer, UNKNOWN_ALBUM, UNKNOWN_ARTIST, norm,
  MB_URL, CAA_URL, LRCLIB_URL, PHONE_PACE, DETAILS_BACKOFF, THROTTLED_FAIL, FILL_DELAY_MS, DETAILS_RETRY_BASE_MS,
  DETAILS_MAX_TRIES, OFFLINE_PAUSE, CAA_KEEP, RELEASE_PAGE, RELEASE_PAGES, LYRICS_PACE_MS, LYRICS_BACKOFF,
  LYRICS_RETRY_BASE_MS, LYRICS_MAX_TRIES, MISS_RETRY_MS
} from './phone-rules.js'
import { splitGenres } from '../web/js/genres.js'

// The genres of a song whose tags have none, as the source asks them (server/details.mjs, GENRES_V):
// the recording's, its album's and its artist's, the artist found by name, alias or sort name when
// the recording is not, Wikidata's for an artist with none on MusicBrainz.
export const GENRES_V = 6
const WD_URL = 'https://www.wikidata.org'
const MB_GENRES = 3
const MAX_SONG_GENRES = 5

function mbGenres (entity) {
  const list = entity && Array.isArray(entity.genres) ? entity.genres : []
  const voted = list
    .filter((g) => g && typeof g.name === 'string' && !(typeof g.count === 'number' && g.count <= 0))
    .sort((a, b) => (b.count || 0) - (a.count || 0) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return splitGenres(voted.slice(0, 2 * MB_GENRES).map((g) => g.name)).slice(0, MB_GENRES)
}

function firstArtist (name) {
  const s = typeof name === 'string' ? name.split(/\s*(?:,|;|\/|&|\bfeat\.?|\bft\.?|\bwith\b)\s*/i)[0].trim() : ''
  return s && s !== UNKNOWN_ARTIST ? s : null
}

function wikidataOf (artist) {
  const rels = artist && Array.isArray(artist.relations) ? artist.relations : []
  for (const r of rels) {
    const url = r && r.type === 'wikidata' && r.url && typeof r.url.resource === 'string' ? r.url.resource : ''
    const m = /\/wiki\/(Q\d+)$/.exec(url)
    if (m) return m[1]
  }
  return null
}

/** When the genres lookup of this track is due: 0 now, a time, or Infinity. */
export function genresDueAt (t) {
  if (!Array.isArray(t.genres) || t.genres.length > 0) return Infinity
  const g = t.genreLookup
  if (!g || g.fileHash !== t.fileHash || (g.gv || 1) < GENRES_V) return 0
  if (g.state !== 'failed' || g.tries >= DETAILS_MAX_TRIES) return Infinity
  return g.at + DETAILS_RETRY_BASE_MS * 2 ** (g.tries - 1)
}

const REQUEST_TIMEOUT_MS = 30000
const MAX_TIMER = 2 ** 31 - 1
const ID_RE = /^[0-9a-f]{24}$/

class Stopped extends Error {}
class LookupFailed extends Error {}
// No answer from the network (`metered`: the host refused it): the job waits.
class Paused extends Error {
  constructor (why) {
    super(why)
    this.why = why
  }
}

/** When a details lookup of this track is due: 0 now, a time, or Infinity. */
/** When a details lookup of this track is due (its missing fields, or its genres): 0 now, a time, or Infinity. */
export function detailsDueAt (t, { genres = true } = {}) {
  return genres ? Math.min(mainDueAt(t), genresDueAt(t)) : mainDueAt(t)
}

function mainDueAt (t) {
  const l = t.lookup
  if (!l || l.fileHash !== t.fileHash) return wantsLookup(t) ? 0 : Infinity
  if (l.state !== 'failed' || l.tries >= DETAILS_MAX_TRIES) return Infinity
  return missingFields(t).length > 0 ? l.at + DETAILS_RETRY_BASE_MS * 2 ** (l.tries - 1) : Infinity
}

/** When an LRCLIB lookup of this track is due: 0 now, a time, or Infinity. */
export function lyricsDueAt (t) {
  const e = t.lyr
  if (!e || e.from === 'tag' || e.from === 'lrc' || !askable(t)) return Infinity
  const l = e.lookup
  if (l === null || e.key !== keyOf(t)) return 0
  if (l.state === 'none') return l.at + MISS_RETRY_MS
  if (l.state === 'failed') return l.tries >= LYRICS_MAX_TRIES ? Infinity : l.at + LYRICS_RETRY_BASE_MS * 2 ** (Math.max(1, l.tries) - 1)
  return Infinity
}

/** What an LRCLIB 200 gives: synced over plain, or instrumental; null when nothing usable. */
export function lyricsAnswerOf (data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null
  if (data.instrumental === true) return { kind: 'instrumental' }
  if (typeof data.syncedLyrics === 'string' && data.syncedLyrics.trim() !== '') {
    try {
      return parseLrc(data.syncedLyrics)
    } catch {}
  }
  if (typeof data.plainLyrics === 'string' && data.plainLyrics.trim() !== '') {
    try {
      return parsePlain(data.plainLyrics)
    } catch {}
  }
  return null
}

function worker () {
  return { queue: [], queued: new Set(), running: false, pauseUntil: 0, wake: null, offlineLevel: 0, metered: false, again: null, lastStart: -Infinity, level: 0 }
}

export class PhoneLookups {
  /**
   * @param {object} deps
   * @param {object} deps.phone  the Locale source: details, shadowKnown(), isShadowed(id),
   *   ensureLoaded(), dueIds(), trackOf(id), summaryDue(), applyDetails(), applyLyrics(),
   *   coverExists(id), writeCover(cover), dropCover(id), readCaa(), writeCaa(map)
   * @param {(msg: object) => void} deps.send  to the host
   */
  constructor ({
    phone, send, log = () => {}, now = Date.now, fillDelayMs = FILL_DELAY_MS, pace = PHONE_PACE, lyricsPaceMs = LYRICS_PACE_MS,
    backoff = DETAILS_BACKOFF, lyricsBackoff = LYRICS_BACKOFF, offlinePause = OFFLINE_PAUSE, timeoutMs = REQUEST_TIMEOUT_MS, genres = true
  }) {
    this.genresOn = genres
    this._gRg = new Map()
    this._gArtist = new Map()
    this._gByName = new Map()
    this._wdLabels = new Map()
    this.phone = phone
    this.send = send
    this.log = log
    this.now = now
    this.fillDelayMs = fillDelayMs
    this.lyricsPaceMs = lyricsPaceMs
    this.lyricsBackoff = lyricsBackoff
    this.offlinePause = offlinePause
    this.timeoutMs = timeoutMs
    const wait = (ms) => this._sleep(ms)
    this.pacers = { musicbrainz: new Pacer(pace.musicbrainz, backoff, { now, wait }), caa: new Pacer(pace.caa, backoff, { now, wait }), wikidata: new Pacer(pace.wikidata === undefined ? pace.musicbrainz : pace.wikidata, backoff, { now, wait }) }
    this.stats = { requests: 0, details: 0, lyrics: 0 }
    this._d = worker()
    this._y = worker()
    this._pending = new Map() // net id -> resolve
    this._netId = 0
    this._open = false // the start's delay is over: the background fill may run
    this._fillTimer = null
    this._retryTimer = null
    this._retryAt = Infinity
    this._sleeps = new Set()
    this._caa = null
    this._closed = false
  }

  get ready () {
    return !this._closed && this.phone.details === true && this.phone.shadowKnown()
  }

  /**
   * After the start: FILL_DELAY_MS later the background fill runs, when the log's
   * summary says something is due by then (else one timer for when it is).
   */
  start () {
    if (this._closed) return
    const due = this.phone.summaryDue()
    this._fillTimer = setTimeout(() => {
      this._fillTimer = null
      this._open = true
      if (due !== null && due <= this.now()) this.fill()
      else if (due !== null) this._armRetry(due)
    }, this.fillDelayMs)
  }

  /** Every track that is due now goes to its queue; one timer for the earliest later one. */
  fill () {
    if (!this.ready) return
    this.phone.ensureLoaded()
    const now = this.now()
    let next = Infinity
    for (const { id, dd, ld } of this.phone.dueIds()) {
      if (this.phone.isShadowed(id)) continue
      if (dd <= now) this._enqueue(this._d, id)
      else next = Math.min(next, dd)
      if (ld <= now) this._enqueue(this._y, id)
      else next = Math.min(next, ld)
    }
    this._armRetry(next)
    this._pump(this._d)
    this._pump(this._y)
  }

  _armRetry (at) {
    if (at === Infinity || this._closed) return
    if (this._retryTimer !== null) {
      if (this._retryAt <= at) return
      clearTimeout(this._retryTimer)
    }
    this._retryAt = at
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null
      this._retryAt = Infinity
      this.fill()
    }, Math.min(Math.max(1000, at - this.now()), MAX_TIMER))
  }

  /** A track that came in or changed: asked about first, when it is due. */
  request (id, { dd, ld }) {
    if (!this.ready || this.phone.isShadowed(id)) return
    const now = this.now()
    if (dd <= now) this._enqueue(this._d, id, true)
    else this._armRetry(dd)
    if (ld <= now) this._enqueue(this._y, id, true)
    else this._armRetry(ld)
    this._pump(this._d)
    this._pump(this._y)
  }

  _enqueue (w, id, first = false) {
    if (w.queued.has(id)) return
    w.queued.add(id)
    if (first) w.queue.unshift(id)
    else w.queue.push(id)
  }

  /** The switch changed. Off: nothing more is sent, what is queued or in flight goes. */
  switchChanged (on) {
    if (!on) {
      this._clear()
      return
    }
    this._open = true
    this.fill()
  }

  /** The page said which songs a real source holds: those it no longer holds are asked about. */
  shadowChanged ({ known, removed }) {
    if (known) {
      if (this._open) this.fill()
      return
    }
    for (const id of removed) {
      const due = this.phone.dueOf(id)
      if (due !== null) this.request(id, due)
    }
  }

  /** The real sources changed: with none left, nothing is held back by them any more. */
  sourcesChanged () {
    if (this._open) this.fill()
  }

  /** The default network changed: a worker held by a metered network tries again. */
  networkChanged () {
    for (const w of [this._d, this._y]) {
      if (!w.metered) continue
      w.metered = false
      this._pump(w)
    }
  }

  netReply (msg) {
    const p = this._pending.get(msg.id)
    if (p !== undefined) p(msg)
  }

  _clear () {
    for (const w of [this._d, this._y]) {
      w.queue = []
      w.queued.clear()
      w.again = null
      w.metered = false
      if (w.wake !== null) clearTimeout(w.wake)
      w.wake = null
    }
    if (this._retryTimer !== null) clearTimeout(this._retryTimer)
    this._retryTimer = null
    this._retryAt = Infinity
    for (const p of [...this._pending.values()]) p({ error: 'stopped' })
    for (const done of [...this._sleeps]) done()
  }

  stop () {
    this._closed = true
    if (this._fillTimer !== null) clearTimeout(this._fillTimer)
    this._fillTimer = null
    this._clear()
  }

  /** Nothing runs and nothing queued may run now (tests). */
  idle () {
    const busy = (w) => w.running || (this.ready && !w.metered && this.now() >= w.pauseUntil && (w.again !== null || w.queue.length > 0))
    return !busy(this._d) && !busy(this._y)
  }

  // ---------------------------------------------------------------- the pumps

  _pump (w) {
    if (this._closed || w.running || !this.ready || w.metered) return
    const wait = w.pauseUntil - this.now()
    if (wait > 0) {
      if (w.wake === null) {
        w.wake = setTimeout(() => {
          w.wake = null
          this._pump(w)
        }, Math.min(wait, MAX_TIMER))
      }
      return
    }
    let id = w.again
    w.again = null
    if (id === null) {
      id = w.queue.shift()
      if (id === undefined) return
      w.queued.delete(id)
    }
    w.running = true
    const run = w === this._d ? this._details(id) : this._lyrics(id)
    run.catch((err) => this.log('lookup of ' + id + ' failed: ' + ((err && err.message) || err)))
      .finally(() => {
        w.running = false
        setTimeout(() => this._pump(w), 0)
      })
  }

  // A pause of a worker: no answer at all (doubling), or a metered network (until it changes).
  _pause (w, id, why) {
    w.again = id
    if (why === 'metered') {
      w.metered = true
      return
    }
    const pause = this.offlinePause[Math.min(w.offlineLevel, this.offlinePause.length - 1)]
    if (w.offlineLevel === 0) this.log('lookups: no answer from the network, they wait')
    w.offlineLevel++
    w.pauseUntil = this.now() + pause
  }

  _sleep (ms) {
    if (ms <= 0) return Promise.resolve()
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this._sleeps.delete(done)
        resolve()
      }
      const timer = setTimeout(done, Math.min(ms, MAX_TIMER))
      this._sleeps.add(done)
    })
  }

  // One request through the host; resolves with its reply ({ error: 'timeout' } after the limit).
  _net (service, url, kind) {
    const id = ++this._netId
    this.stats.requests++
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish({ error: 'timeout' }), this.timeoutMs)
      const finish = (msg) => {
        clearTimeout(timer)
        this._pending.delete(id)
        resolve(msg)
      }
      this._pending.set(id, finish)
      try {
        this.send({ t: 'net', id, service, url, kind })
      } catch {
        finish({ error: 'unsent' })
      }
    })
  }

  // ---------------------------------------------------------------- details

  async _details (id) {
    const t = this.phone.trackOf(id)
    if (t === null || this.phone.isShadowed(id) || detailsDueAt(t, { genres: this.genresOn }) > this.now()) return
    if (mainDueAt(t) > this.now()) {
      if (this.genresOn) await this._runGenres(id, t)
      return
    }
    this.stats.details++
    const previous = t.lookup && t.lookup.fileHash === t.fileHash ? t.lookup : null
    const tries = previous !== null && previous.state === 'failed' ? previous.tries + 1 : 1
    const album = t.album
    const ctx = { throttled: 0, answered: false, recording: null }
    let result
    try {
      result = await this._lookup(t, album, ctx)
    } catch (err) {
      if (err instanceof Stopped || !this.ready) return
      if (err instanceof Paused) return this._pause(this._d, id, err.why)
      if (!(err instanceof LookupFailed)) this.log('details of ' + id + ': ' + ((err && err.message) || err))
      result = { state: 'failed', recording: ctx.recording, release: null, values: null, coverId: null }
    }
    this._d.offlineLevel = 0
    if (!this.ready) return
    await this.phone.applyDetails(id, { fileHash: t.fileHash, album, result, tries, at: this.now() })
  }

  async _lookup (t, album, ctx) {
    const hints = hintsOf(t)
    const albumHint = album && album !== UNKNOWN_ALBUM ? album : null
    const ms = typeof t.duration === 'number' ? Math.round(t.duration * 1000) : null
    if (!hints.usable || ms === null) return nothing()
    const answer = await this._mb('/ws/2/recording?query=' + encodeURIComponent(searchQuery(hints, ms)) + '&fmt=json&limit=10', ctx)
    const found = answer === null ? null : chooseFromSearch(answer, hints, ms)
    if (found === null) return nothing()
    const recordingId = found.id
    ctx.recording = recordingId
    const recording = await this._mb('/ws/2/recording/' + encodeURIComponent(recordingId) + '?inc=releases+release-groups+media+artist-credits&fmt=json', ctx)
    if (recording === null) return nothing()
    const releases = Array.isArray(recording.releases) ? recording.releases : []
    let release = null
    let positions = null
    if (releases.length === 25) {
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
    const done = { recording: recordingId, release: release ? release.id : null, values }
    let coverId = null
    if (release !== null && missingFields(t, values).includes('cover')) {
      const rg = release['release-group'] && typeof release['release-group'].id === 'string' ? release['release-group'].id : null
      try {
        coverId = await this._cover(release.id, rg, ctx)
      } catch (err) {
        if (!(err instanceof LookupFailed)) throw err
        return { state: 'failed', ...done, coverId: null }
      }
    }
    return { state: 'applied', ...done, coverId }
  }

  // ------------------------------------------------------------------ genres

  async _runGenres (id, t) {
    const prev = t.genreLookup && t.genreLookup.fileHash === t.fileHash ? t.genreLookup : null
    const tries = prev !== null && prev.state === 'failed' ? prev.tries + 1 : 1
    const ctx = { throttled: 0, answered: false, recording: null }
    let state = 'done'
    let genres = []
    try {
      genres = await this._lookupGenres(t, ctx)
    } catch (err) {
      if (err instanceof Stopped || !this.ready) return
      if (err instanceof Paused) return this._pause(this._d, id, err.why)
      if (!(err instanceof LookupFailed)) this.log('genres of ' + id + ': ' + ((err && err.message) || err))
      state = 'failed'
      genres = []
    }
    this._d.offlineLevel = 0
    if (!this.ready) return
    await this.phone.applyGenres(id, { fileHash: t.fileHash, state, genres, tries, at: this.now() })
  }

  async _lookupGenres (t, ctx) {
    const l = t.lookup
    let recordingId = l && l.fileHash === t.fileHash && typeof l.recording === 'string' ? l.recording : null
    if (recordingId === null) {
      const hints = hintsOf(t)
      const ms = typeof t.duration === 'number' ? Math.round(t.duration * 1000) : null
      if (!hints.usable || ms === null) return this._genresByArtistName(t, ctx)
      const answer = await this._mb('/ws/2/recording?query=' + encodeURIComponent(searchQuery(hints, ms)) + '&fmt=json&limit=10', ctx)
      const found = answer === null ? null : chooseFromSearch(answer, hints, ms)
      if (found === null) return this._genresByArtistName(t, ctx)
      recordingId = found.id
    }
    return this._genresOfRecording(recordingId, t, ctx)
  }

  async _genresOfRecording (recordingId, t, ctx) {
    const albumHint = t.album && t.album !== UNKNOWN_ALBUM ? t.album : null
    const recording = await this._mb('/ws/2/recording/' + encodeURIComponent(recordingId) + '?inc=genres+releases+release-groups+artist-credits&fmt=json', ctx)
    if (recording === null) return []
    const releases = Array.isArray(recording.releases) ? recording.releases : []
    let release = chooseRelease(releases, albumHint)
    if (!releaseFits(release, albumHint, releases)) release = null
    const lists = [mbGenres(recording)]
    const rg = release && release['release-group'] && typeof release['release-group'].id === 'string' ? release['release-group'].id : null
    if (rg !== null) {
      if (!this._gRg.has(rg)) {
        const a = await this._mb('/ws/2/release-group/' + encodeURIComponent(rg) + '?inc=genres&fmt=json', ctx)
        this._gRg.set(rg, a === null ? [] : mbGenres(a))
      }
      lists.push(this._gRg.get(rg))
    }
    const credits = Array.isArray(recording['artist-credit']) ? recording['artist-credit'] : []
    const artist = credits[0] && credits[0].artist && typeof credits[0].artist.id === 'string' ? credits[0].artist.id : null
    if (artist !== null) lists.push(await this._artistGenresOf(artist, ctx))
    return splitGenres(lists.flat()).slice(0, MAX_SONG_GENRES)
  }

  async _genresByArtistName (t, ctx) {
    const name = firstArtist(t.artist)
    if (name === null) return []
    const key = norm(name)
    let ids = this._gByName.get(key)
    if (ids === undefined) {
      const n = '"' + name.replace(/[\\"]/g, (c) => '\\' + c) + '"'
      const answer = await this._mb('/ws/2/artist?query=' + encodeURIComponent('artist:' + n + ' OR alias:' + n + ' OR sortname:' + n) + '&fmt=json&limit=5', ctx)
      const list = answer && Array.isArray(answer.artists) ? answer.artists : []
      const same = (x) => typeof x === 'string' && norm(x) === key
      const hits = list.filter((a) => a && typeof a.id === 'string' && !(typeof a.score === 'number' && a.score < 95) && (same(a.name) || same(a['sort-name']) || (Array.isArray(a.aliases) && a.aliases.some((x) => x && same(x.name)))))
      ids = [...new Set(hits.map((a) => a.id))].slice(0, 3)
      this._gByName.set(key, ids)
    }
    if (ids.length === 0) return []
    const hints = hintsOf(t)
    const ms = typeof t.duration === 'number' ? Math.round(t.duration * 1000) : null
    if (hints.usable && ms !== null) {
      for (const id of ids) {
        const q = searchQuery({ title: hints.title, artist: null }, ms) + ' AND arid:' + id
        const answer = await this._mb('/ws/2/recording?query=' + encodeURIComponent(q) + '&fmt=json&limit=10', ctx)
        const found = answer === null ? null : chooseFromSearch(answer, { ...hints, artist: null }, ms)
        if (found !== null) return this._genresOfRecording(found.id, t, ctx)
      }
    }
    return ids.length === 1 ? this._artistGenresOf(ids[0], ctx) : []
  }

  async _artistGenresOf (id, ctx) {
    if (this._gArtist.has(id)) return this._gArtist.get(id)
    const answer = await this._mb('/ws/2/artist/' + encodeURIComponent(id) + '?inc=genres+url-rels&fmt=json', ctx)
    let g = answer === null ? [] : mbGenres(answer)
    const qid = g.length === 0 ? wikidataOf(answer) : null
    if (qid !== null) g = await this._wikidataGenres(qid, ctx)
    this._gArtist.set(id, g)
    return g
  }

  async _wikidataGenres (qid, ctx) {
    const item = await this._wd('/w/api.php?action=wbgetentities&ids=' + qid + '&props=claims&format=json', ctx)
    const claims = item && item.entities && item.entities[qid] && item.entities[qid].claims
    const ids = (claims && Array.isArray(claims.P136) ? claims.P136 : [])
      .map((c) => c && c.mainsnak && c.mainsnak.datavalue && c.mainsnak.datavalue.value && c.mainsnak.datavalue.value.id)
      .filter((x) => typeof x === 'string' && /^Q\d+$/.test(x))
      .slice(0, 2 * MB_GENRES)
    if (ids.length === 0) return []
    const missing = ids.filter((q) => !this._wdLabels.has(q))
    if (missing.length > 0) {
      const labels = await this._wd('/w/api.php?action=wbgetentities&ids=' + encodeURIComponent(missing.join('|')) + '&props=labels&languages=en&format=json', ctx)
      for (const q of missing) {
        const l = labels && labels.entities && labels.entities[q] && labels.entities[q].labels && labels.entities[q].labels.en
        this._wdLabels.set(q, l && typeof l.value === 'string' ? l.value : null)
      }
    }
    return splitGenres(ids.map((q) => this._wdLabels.get(q)).filter(Boolean)).slice(0, MB_GENRES)
  }

  async _wd (pathAndQuery, ctx) {
    const reply = await this._call('wikidata', WD_URL + pathAndQuery, 'json', ctx)
    if (reply.status === 404) return null
    if (reply.status !== 200) throw new LookupFailed('Wikidata answered ' + reply.status)
    return jsonOf(reply)
  }

  async _mb (pathAndQuery, ctx) {
    const reply = await this._call('musicbrainz', MB_URL + pathAndQuery, 'json', ctx)
    if (reply.status === 404) return null
    if (reply.status !== 200) throw new LookupFailed('MusicBrainz answered ' + reply.status)
    return jsonOf(reply)
  }

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

  // The front cover of a release (else of its release group), as the host made it:
  // its id and its two sizes, kept in the core's art folder. Each release once.
  async _cover (releaseId, groupId, ctx) {
    const caa = this._caaMap()
    const cached = caa.get(releaseId)
    if (cached !== undefined && (cached.coverId === null || this.phone.coverExists(cached.coverId))) return cached.coverId
    let reply = await this._call('caa', CAA_URL + '/release/' + encodeURIComponent(releaseId) + '/front-500', 'cover', ctx)
    if (reply.status === 404 && groupId !== null) reply = await this._call('caa', CAA_URL + '/release-group/' + encodeURIComponent(groupId) + '/front-500', 'cover', ctx)
    let coverId = null
    if (reply.status === 200) {
      coverId = await this.phone.writeCover(reply.cover)
    } else if (reply.status !== 404) {
      throw new LookupFailed('Cover Art Archive answered ' + reply.status)
    }
    caa.set(releaseId, { coverId, at: this.now() })
    if (caa.size > CAA_KEEP) {
      const oldest = [...caa].sort((a, b) => a[1].at - b[1].at).slice(0, caa.size - CAA_KEEP)
      for (const [id] of oldest) caa.delete(id)
    }
    this.phone.writeCaa(caa)
    return coverId
  }

  _caaMap () {
    if (this._caa === null) this._caa = this.phone.readCaa()
    return this._caa
  }

  // One request, paced, with the back-off on 429 and 503 (three in a row: failed).
  async _call (service, url, kind, ctx) {
    const pacer = this.pacers[service]
    for (;;) {
      if (!this.ready) throw new Stopped()
      await pacer.slot()
      if (!this.ready) throw new Stopped()
      let reply
      try {
        reply = await this._net(service, url, kind)
      } finally {
        pacer.done()
      }
      if (!this.ready || reply.error === 'stopped') throw new Stopped()
      if (typeof reply.error === 'string') {
        if (reply.error === 'metered') throw new Paused('metered')
        if (reply.error === 'too_large' && service === 'caa') return { status: 200, cover: null }
        if (reply.error === 'too_large') throw new LookupFailed(service + ': answer too large')
        if (!ctx.answered) throw new Paused('offline')
        throw new LookupFailed(service + ': ' + reply.error)
      }
      ctx.answered = true
      if (reply.status === 429 || reply.status === 503) {
        pacer.throttled()
        if (++ctx.throttled >= THROTTLED_FAIL) throw new LookupFailed(service + ' busy')
        continue
      }
      pacer.calm()
      ctx.throttled = 0
      return reply
    }
  }

  // ----------------------------------------------------------------- lyrics

  async _lyrics (id) {
    const w = this._y
    let t = this.phone.trackOf(id)
    if (t === null || this.phone.isShadowed(id) || lyricsDueAt(t) > this.now()) return
    await this._sleep(w.lastStart + this.lyricsPaceMs - this.now())
    if (!this.ready) return
    t = this.phone.trackOf(id)
    if (t === null || this.phone.isShadowed(id) || lyricsDueAt(t) > this.now()) return
    w.lastStart = this.now()
    this.stats.lyrics++
    const key = keyOf(t)
    const reply = await this._net('lrclib', LRCLIB_URL + queryOf(t), 'json')
    if (!this.ready || reply.error === 'stopped') return
    if (typeof reply.error === 'string' && reply.error !== 'too_large') return this._pause(w, id, reply.error === 'metered' ? 'metered' : 'offline')
    w.offlineLevel = 0
    if (reply.status === 429 || reply.status === 503) {
      const wait = retryAfterMs(reply.retryAfter, this.now())
      w.pauseUntil = this.now() + (wait !== null ? wait : this.lyricsBackoff[Math.min(w.level, this.lyricsBackoff.length - 1)])
      w.level++
      w.again = id
      return
    }
    w.level = 0
    let found = null
    let state = 'failed'
    if (reply.status === 200 && reply.error === undefined) {
      let data = null
      try {
        data = jsonOf(reply)
      } catch {}
      if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
        found = lyricsAnswerOf(data)
        state = found !== null ? 'found' : 'none'
      }
    } else if (reply.status === 404) {
      state = 'none'
    }
    await this.phone.applyLyrics(id, { key, state, found, at: this.now() })
  }
}

function nothing () {
  return { state: 'nothing', recording: null, release: null, values: null, coverId: null }
}

// The JSON of a reply: the host sends it parsed or as its text.
function jsonOf (reply) {
  if (reply.json !== null && typeof reply.json === 'object') return reply.json
  if (typeof reply.json === 'string') {
    try {
      return JSON.parse(reply.json)
    } catch {}
  }
  throw new LookupFailed('answer is not JSON')
}

/** A cover the host made from an answer: { coverId, small, large } (base64 JPEGs), or null. */
export function coverOf (cover) {
  if (cover === null || typeof cover !== 'object') return null
  if (typeof cover.coverId !== 'string' || !ID_RE.test(cover.coverId)) return null
  if (typeof cover.small !== 'string' || typeof cover.large !== 'string') return null
  const small = b4a.from(cover.small, 'base64')
  const large = b4a.from(cover.large, 'base64')
  const jpeg = (b) => b.byteLength > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
  if (!jpeg(small) || !jpeg(large)) return null
  return { coverId: cover.coverId, small, large }
}
