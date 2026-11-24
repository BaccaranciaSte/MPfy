// The rules the phone's core shares with the source. Modules that import nothing
// are byte-for-byte copies (client-core/lrc.js, userops.js, versions.js); the rules
// that live in files the core cannot import are copied into
// client-core/phone-rules.js and run here on the same inputs as the source's own
// code, several hundred generated ones and the hard cases of the source's tests,
// wanting equal outputs. Every lyric line in here is invented.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { parseFile } from 'music-metadata'
import * as lrc from '../server/lrc.mjs'
import * as media from '../server/media.mjs'
import * as quality from '../server/quality.mjs'
import * as ids from '../server/ids.mjs'
import * as details from '../server/details.mjs'
import * as lyrics from '../server/lyrics.mjs'
import { tmpDir, cleanup, makeMp3 } from './helpers.mjs'
import { usltFrame, syltFrame, makeFlac, makeM4a } from './lyrics-fixtures.mjs'

const root = new URL('../', import.meta.url)
const read = (rel) => fs.readFileSync(new URL(rel, root))
const rules = await import('../client-core/phone-rules.js')
const coreLrc = await import('../client-core/lrc.js')

// A small seeded generator, so a failure names a vector that comes back.
function rng (seed) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const pick = (r, list) => list[Math.floor(r() * list.length)]
const maybe = (r, p, v) => (r() < p ? v : null)

// The source's constants that its files do not export, read from their text.
function constOf (file, name) {
  const m = new RegExp('^const ' + name + ' = (.+)$', 'm').exec(read(file).toString('utf8'))
  assert.ok(m, name + ' in ' + file)
  return Function('return ' + m[1])() // eslint-disable-line no-new-func
}

// --------------------------------------------------------------- the copies

test('copies: lrc, userops and versions in the core are byte for byte the source\'s', () => {
  assert.ok(read('client-core/lrc.js').equals(read('server/lrc.mjs')), 'client-core/lrc.js differs from server/lrc.mjs')
  assert.ok(read('client-core/userops.js').equals(read('web/js/userops.js')), 'client-core/userops.js differs from web/js/userops.js')
  assert.ok(read('client-core/userops.js').equals(read('server/userops.mjs')), 'client-core/userops.js differs from server/userops.mjs')
  assert.ok(read('client-core/versions.js').equals(read('server/versions.mjs')), 'client-core/versions.js differs from server/versions.mjs')
  // Copies only of files that import nothing: the core has no node: modules, no Buffer.
  for (const f of ['server/lrc.mjs', 'web/js/userops.js', 'server/versions.mjs']) {
    const code = read(f).toString('utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    assert.doesNotMatch(code, /^\s*import\s/m, f + ' imports something')
    assert.doesNotMatch(code, /\bBuffer\b|\bTextEncoder\b|\bURL(SearchParams)?\b|\brequire\(|\bprocess\./, f + ' uses a Node global')
  }
})

test('UTF-8 length: the same count as Buffer.byteLength, lone surrogates included', () => {
  const r = rng(7)
  const units = [0x41, 0x7f, 0x80, 0xe8, 0x7ff, 0x800, 0x20ac, 0xd83c, 0xdf0a, 0xd800, 0xdfff, 0xfffd, 0xffff, 0x0a]
  for (let n = 0; n < 500; n++) {
    let s = ''
    const len = Math.floor(r() * 12)
    for (let i = 0; i < len; i++) s += String.fromCharCode(pick(r, units))
    assert.equal(lrc.utf8Length(s), Buffer.byteLength(s, 'utf8'), JSON.stringify(s))
  }
  // The 64 KB limit at its edge, in two-byte characters.
  const edge = 'è'.repeat(32768)
  assert.equal(lrc.parsePlain(edge).text.length, 500, 'exactly 64 KB is taken')
  assert.throws(() => lrc.parsePlain(edge + 'è'), lrc.LyricsError, 'one byte over is refused')
})

// --------------------------------------------------------------- the lyrics

const LINES = ['Lascio il molo al buio', 'Il vento sa il mio nome', 'Torno quando il mare dorme', 'Una lanterna sul pontile']
const LRC = '[ti:Ultimo traghetto]\n[ar:Lumen Marino]\n[00:01.00]' + LINES[0] + '\n[00:04.50]' + LINES[1] + '\n[00:08.00]' + LINES[2] + '\n[00:12.25]' + LINES[3] + '\n'
const PLAIN = LINES.join('\n')
const SYNCED = [{ t: 1000, text: LINES[0] }, { t: 4500, text: LINES[1] }, { t: 8000, text: LINES[2] }, { t: 12250, text: LINES[3] }]

// The parts in the form the phone sends them: lists of { t, text } and the texts.
function phoneParts (metadata) {
  const p = lrc.lyricsPartsOf(metadata)
  return { synced: p.synced.map((list) => list.map((it) => ({ t: it.timestamp, text: it.text }))), texts: p.texts }
}

test('lyrics from the parts equal lyrics from the tags, on every file of the lyrics tests and in the phone\'s form', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  const mp3 = (title, extraFrames = []) => makeMp3({ title, artist: 'Lumen Marino', album: 'Ultimo traghetto', extraFrames })
  const cases = [
    ['sylt.mp3', mp3('Sylt', [syltFrame(SYNCED)]), { kind: 'synced', lines: SYNCED }],
    ['uslt-lrc.mp3', mp3('Uslt Lrc', [usltFrame(LRC)]), { kind: 'synced', lines: SYNCED }],
    ['uslt-plain.mp3', mp3('Uslt Plain', [usltFrame(PLAIN + '\nCittà di sale')]), { kind: 'plain', text: PLAIN + '\nCittà di sale' }],
    ['both.mp3', mp3('Both', [usltFrame(PLAIN), syltFrame(SYNCED)]), { kind: 'synced', lines: SYNCED }],
    ['frames.mp3', mp3('Frames', [syltFrame(SYNCED, { format: 1 })]), null],
    ['none.mp3', mp3('None'), null],
    ['lyrics.flac', makeFlac({ comments: { TITLE: 'Flac', ARTIST: 'Lumen Marino', LYRICS: '[offset:+500]\n[00:02.00][00:30.00]' + LINES[0] + '\n[00:06.00]' + LINES[1] + '\n[00:09.00]' + LINES[2] } }),
      { kind: 'synced', lines: [{ t: 1500, text: LINES[0] }, { t: 5500, text: LINES[1] }, { t: 8500, text: LINES[2] }, { t: 29500, text: LINES[0] }] }],
    ['plain.flac', makeFlac({ comments: { TITLE: 'Flac piano', LYRICS: PLAIN } }), { kind: 'plain', text: PLAIN }],
    ['lyr.m4a', makeM4a({ title: 'M4a', lyrics: PLAIN }), { kind: 'plain', text: PLAIN }],
    ['lrc.m4a', makeM4a({ title: 'M4a lrc', lyrics: LRC }), { kind: 'synced', lines: SYNCED }]
  ]
  for (const [name, bytes, want] of cases) {
    const file = path.join(dir, name)
    fs.writeFileSync(file, bytes)
    const metadata = await parseFile(file, { duration: false, skipCovers: true })
    const parts = lrc.lyricsPartsOf(metadata)
    assert.deepEqual(lrc.lyricsFromTags(metadata), want, name)
    assert.deepEqual(lrc.lyricsFromParts(parts.synced, parts.texts, (it) => it.timestamp), want, name + ': the parts')
    const phone = phoneParts(metadata)
    assert.deepEqual(coreLrc.lyricsFromParts(phone.synced, phone.texts), want, name + ': the phone\'s form in the core')
  }
  // The fallback on common.lyrics, and plain then synced in one list.
  const common = { native: {}, common: { lyrics: [{ text: PLAIN }, { timeStampFormat: 2, syncText: SYNCED.map((l) => ({ timestamp: l.t, text: l.text })) }] } }
  assert.deepEqual(lrc.lyricsFromTags(common), { kind: 'synced', lines: SYNCED })
  // A synced list in the phone's form is read one item at a time, never copied.
  let reads = 0
  const entries = new Proxy(Array.from({ length: 200000 }, (_, i) => ({ t: i, text: 'riga ' + i })), {
    get (target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads++
      return Reflect.get(target, key, receiver)
    }
  })
  assert.equal(coreLrc.lyricsFromParts([entries], []), null)
  assert.ok(reads <= coreLrc.MAX_LINES + 1, reads + ' entries read')
  assert.equal(coreLrc.lyricsFromParts([], [(LINES[0] + '\n').repeat(50000)]), null, 'a text over 64 KB is no lyrics')
  assert.equal(coreLrc.lyricsFromParts([[{ t: -1, text: 'x' }]], ['  ']), null)
  assert.deepEqual(coreLrc.lyricsFromParts(null, ['[00:01]a\n[00:02]b\n[00:03]c']), { kind: 'synced', lines: [{ t: 1000, text: 'a' }, { t: 2000, text: 'b' }, { t: 3000, text: 'c' }] })
})

// ------------------------------------------------------------ the track built

const FORMATS = ['mp3', 'aac', 'm4a', 'flac', 'ogg', 'opus', 'wav']
const CODECS = ['audio/mpeg', 'audio/mp4a-latm', 'audio/alac', 'audio/flac', 'audio/vorbis', 'audio/opus', 'audio/raw', 'ALAC', null, '']
const TEXTS = [null, '', '  ', 'Mare', ' Ultimo traghetto ', 'Lumen\tMarino', 'riga\nnuova', 'Città di sale', '夜に駆ける', 'a'.repeat(600), '\u0000x\u001f', 'Artista sconosciuto', 'Album sconosciuto']
const SORTS = [undefined, null, '', '  ', ' Beatles, The ', 'Fujii Kaze', 'a'.repeat(600)]
const GAINS = [undefined, null, {}, { trackGain: -6.52, trackPeak: 0.988 }, { trackGain: 3.1, albumGain: -2, albumPeak: 1.2 }, { r128Track: -1234, r128Album: 512 }, { trackGain: NaN }, { trackGain: -200 }, { trackPeak: 0.5 }, { trackGain: -9, r128Track: 100 }]
// ReplayGain as music-metadata gives it (dB and ratio), R128 as an Opus tag.
function gainsOf (rg) {
  if (!rg) return {}
  const gain = (v) => (v === undefined ? undefined : { dB: v, ratio: 10 ** (v / 20) })
  const peak = (v) => (v === undefined ? undefined : { ratio: v, dB: 20 * Math.log10(v) })
  return { replaygain_track_gain: gain(rg.trackGain), replaygain_track_peak: peak(rg.trackPeak), replaygain_album_gain: gain(rg.albumGain), replaygain_album_peak: peak(rg.albumPeak) }
}
function r128Of (rg) {
  if (!rg) return {}
  const tags = []
  if (rg.r128Track !== undefined) tags.push({ id: 'R128_TRACK_GAIN', value: String(rg.r128Track) })
  if (rg.r128Album !== undefined) tags.push({ id: 'R128_ALBUM_GAIN', value: String(rg.r128Album) })
  return { vorbis: tags }
}
const GENRES = [undefined, [], ['J-Pop'], ['Hip-Hop/Rap', 'rap', ''], ['Soundtrack\u0000Musical'], ['  ', '(17)'], ['a'.repeat(60), 'Città pop', '夜', 'Rock', 'Metal', 'Jazz', 'Folk']]
const NUMBERS = [null, 0, -1, 1, 3, 12, 2019, 1.5, '3', NaN]
const NAMES = ['01 - Mare.mp3', 'Mare.flac', '.mp3', 'senza estensione', '  spazi  .m4a', '', 'a/b\\c.ogg', 'x\u202e.mp3', 'Artista - Titolo.opus', '03.Traccia 3.wav']

function facts (r, n) {
  const id = n.toString(16).padStart(24, 'a')
  const format = pick(r, FORMATS)
  return {
    id,
    name: pick(r, NAMES),
    size: Math.floor(r() * 2e7),
    mtime: 1763380000000 + n,
    addedAt: 1763380000000 + Math.floor(r() * 1e9),
    tags: {
      title: pick(r, TEXTS),
      artist: pick(r, TEXTS),
      album: pick(r, TEXTS),
      albumArtist: pick(r, TEXTS),
      trackNo: pick(r, NUMBERS),
      discNo: pick(r, NUMBERS),
      year: pick(r, NUMBERS),
      genres: pick(r, GENRES),
      artistSort: pick(r, SORTS),
      albumArtistSort: pick(r, SORTS),
      albumSort: pick(r, SORTS),
      titleSort: pick(r, SORTS),
      rg: pick(r, GAINS)
    },
    format,
    codec: pick(r, CODECS),
    duration: pick(r, [null, 0, 0.6, 241.3714, 3600.0004, NaN]),
    bitrate: pick(r, [null, 0, 320000, 128000.4, 941234]),
    sampleRate: pick(r, [null, 0, 44100, 48000, 96000.2]),
    bitDepth: pick(r, [null, 0, 16, 24]),
    coverId: maybe(r, 0.5, (n * 7).toString(16).padStart(24, 'c')),
    lyrics: null,
    was: []
  }
}

// What music-metadata would have said of the same file.
function metadataOf (F) {
  const num = (v) => (v === null ? undefined : v)
  return {
    common: {
      title: num(F.tags.title),
      artist: num(F.tags.artist),
      album: num(F.tags.album),
      albumartist: num(F.tags.albumArtist),
      track: { no: F.tags.trackNo, of: null },
      disk: { no: F.tags.discNo, of: null },
      year: num(F.tags.year),
      genre: F.tags.genres || [],
      artistsort: num(F.tags.artistSort),
      albumartistsort: num(F.tags.albumArtistSort),
      albumsort: num(F.tags.albumSort),
      titlesort: num(F.tags.titleSort),
      ...gainsOf(F.tags.rg)
    },
    native: r128Of(F.tags.rg),
    format: { duration: num(F.duration), bitrate: num(F.bitrate), sampleRate: num(F.sampleRate), bitsPerSample: num(F.bitDepth), codec: num(F.codec) }
  }
}

test('the track from the phone\'s facts equals buildTrack of the source for the same raw values (500 vectors)', () => {
  const r = rng(11)
  for (let n = 0; n < 500; n++) {
    const F = facts(r, n)
    const want = media.buildTrack({
      id: F.id,
      format: F.format,
      metadata: metadataOf(F),
      size: F.size,
      fallbackTitle: ids.titleFromFileName(ids.cleanUploadName(F.name), F.id),
      coverId: F.coverId,
      addedAt: F.addedAt
    })
    assert.deepEqual(rules.trackFromFacts(F), want, JSON.stringify(F))
    assert.deepEqual(rules.taglessOf(F.tags, F.coverId), media.taglessOf(metadataOf(F).common, F.coverId))
    assert.equal(rules.isLossless(F.format, F.codec), media.isLossless(F.format, metadataOf(F)))
    assert.equal(rules.codecOf(F.format, rules.isLossless(F.format, F.codec), F.codec), quality.codecOf(F.format, media.isLossless(F.format, metadataOf(F)), F.codec))
    assert.equal(rules.cleanUploadName(F.name), ids.cleanUploadName(F.name))
  }
  assert.deepEqual(rules.TAGLESS_FIELDS, media.TAGLESS_FIELDS)
  assert.equal(rules.UNKNOWN_ARTIST, media.UNKNOWN_ARTIST)
  assert.equal(rules.UNKNOWN_ALBUM, media.UNKNOWN_ALBUM)
  for (const f of FORMATS) assert.equal(rules.AUDIO_MIME[f], ids.AUDIO_FORMATS[f].mime)
})

// ------------------------------------------------------------- the details

const WORDS = [
  'Disco', 'Live', 'Alive', 'Mare', 'Rain', 'Brain', 'Damage', 'Blue', 'Regret', 'Greatest', 'Hits', 'Vol.', '2', 'II', 'Led', 'Zeppelin',
  '夜に駆ける', 'ＡＩＺＯ', 'ショートケーキ', 'ショート', 'ブルー', 'リグレット', 'Track', 'traccia02', 'Audio', 'untitled', 'Senza', 'titolo', '07',
  'Deluxe', 'Edition', 'Remastered', '2009', '20th', 'Anniversary', 'EP', 'Single', '(Live)', '[Official]', '【MV】', '（Live）',
  'feat.', 'ft.', 'Someone', '(instrumental)', '(off vocal)', '- Live', '- Single', '- EP', '÷', '( )', '+', '×', '7', 'Città', 'Oliver!',
  '(Deluxe Edition)', 'Version', 'remix', '(Original Mix)', '~TV size~', 'Karaoke', '-off vocal-', 'Demo', 'Acoustic', 'The', 'Book'
]
const SEPS = [' ', ' ', ' ', ' - ', '. ', '', ' & ', '_']

function text (r, max = 5) {
  const n = 1 + Math.floor(r() * max)
  let s = pick(r, ['', '', '', '03 - ', '7. ', '01 '])
  for (let i = 0; i < n; i++) s += (i > 0 ? pick(r, SEPS) : '') + pick(r, WORDS)
  return r() < 0.1 ? s.toUpperCase() : s
}

function track (r, n) {
  const tagless = media.TAGLESS_FIELDS.filter(() => r() < 0.5)
  const id = n.toString(16).padStart(24, '0')
  return {
    id,
    title: r() < 0.05 ? id : text(r),
    artist: r() < 0.3 ? 'Artista sconosciuto' : text(r, 2),
    albumArtist: r() < 0.3 ? 'Artista sconosciuto' : text(r, 2),
    album: r() < 0.3 ? 'Album sconosciuto' : text(r, 3),
    year: maybe(r, 0.5, 2000 + Math.floor(r() * 20)),
    trackNo: maybe(r, 0.5, 1 + Math.floor(r() * 12)),
    discNo: maybe(r, 0.5, 1),
    coverId: maybe(r, 0.5, 'c'.repeat(24)),
    duration: maybe(r, 0.9, 30 + r() * 300),
    tagless: r() < 0.05 ? null : tagless,
    edited: r() < 0.1 ? [pick(r, ['title', 'artist', 'album'])] : [],
    editedUnknown: r() < 0.1
  }
}

function release (r, i) {
  const type = pick(r, ['Album', 'Album', 'EP', 'Single', 'Other', undefined])
  return {
    id: pick(r, ['a', 'b', 'c', 'd']) + i,
    title: text(r, 3),
    status: pick(r, ['Official', 'Official', 'Bootleg', 'Promotion', 'Pseudo-Release', undefined]),
    date: pick(r, ['2019-01-01', '2017', '2020-02-02', undefined, '', 'x2020']),
    'artist-credit': [{ name: text(r, 2), joinphrase: pick(r, [undefined, ' & ', ', ']) }, ...(r() < 0.3 ? [{ name: text(r, 1) }] : [])],
    'release-group': r() < 0.1 ? undefined : { id: 'g' + Math.floor(r() * 4), title: r() < 0.5 ? text(r, 3) : undefined, 'primary-type': type, 'secondary-types': r() < 0.2 ? ['Compilation'] : [], 'first-release-date': pick(r, ['2001-02-03', undefined]) },
    media: r() < 0.3 ? undefined : [{ position: pick(r, [1, 2, 0, undefined]), tracks: [{ position: pick(r, [1, 7, 0, undefined]), recording: { id: pick(r, ['r1', 'r2']) } }] }]
  }
}

function recording (r, i) {
  return { id: 'rec' + i, score: pick(r, [100, 95, 90, 89, undefined]), title: text(r, 3), length: pick(r, [200000, 201500, 203000, 203100, undefined]), 'artist-credit': [{ name: pick(r, ['X', 'Y', 'Artista']) }] }
}

test('details rules: the core\'s copies give the source\'s answers (generated vectors and the hard cases)', () => {
  const r = rng(23)
  const same = (name, ...args) => assert.deepEqual(rules[name](...args), details[name](...args), name + ' ' + JSON.stringify(args))
  for (let n = 0; n < 600; n++) {
    const a = text(r)
    const b = r() < 0.3 ? a + pick(r, [' (Deluxe Edition)', ' - Single', ' 2', ' Remastered 2009', '']) : text(r)
    same('norm', a)
    same('textsMatch', details.norm(a), details.norm(b))
    same('sameAlbum', a, b)
    same('albumsMatch', a, b)
    same('stripTrackNo', a)
    same('junkTitle', a)
    same('usableTitle', a)
    const t = track(r, n)
    same('hintsOf', t)
    same('missingFields', t)
    same('wantsLookup', t)
    const values = { title: maybe(r, 0.7, text(r)), artist: maybe(r, 0.7, text(r, 2)), album: maybe(r, 0.7, text(r, 2)), albumArtist: maybe(r, 0.5, text(r, 1)), year: maybe(r, 0.5, 2001), trackNo: maybe(r, 0.5, 3), discNo: maybe(r, 0.5, 1), cover: null }
    same('missingFields', t, values)
    const rels = Array.from({ length: Math.floor(r() * 6) }, (_, i) => release(r, i))
    const hint = r() < 0.4 ? null : r() < 0.5 && rels.length > 0 ? rels[0].title : text(r, 3)
    same('chooseRelease', rels, hint)
    same('releaseFits', rels[0] || null, hint, rels)
    same('artistText', rels[0] ? rels[0]['artist-credit'] : null)
    const rec = { title: text(r), 'artist-credit': [{ name: text(r, 1) }] }
    same('valuesOf', rec, rels[0] || null, r() < 0.5 ? null : { trackNo: 4, discNo: 2 })
    same('positionsOf', rels[0] || null, pick(r, ['r1', 'r2']))
    const hints = { title: text(r), artist: maybe(r, 0.5, pick(r, ['X', 'Artista', 'Y'])) }
    same('searchQuery', hints, 200000 + Math.floor(r() * 10000))
    const recs = Array.from({ length: Math.floor(r() * 4) }, (_, i) => recording(r, i))
    if (r() < 0.5 && recs.length > 0) recs[0].title = hints.title
    same('chooseFromSearch', { recordings: recs }, hints, 200000)
  }
  // The hard cases of the source's own tests.
  for (const s of ['Archive (feat. stb & Sasa.)', 'Song feat. Someone Else', '【MV】夜に駆ける [Official]', 'ＡＩＺＯ（Live）']) same('norm', s)
  for (const s of ['traccia02', 'Track 7', '01 - traccia03', 'Audio', 'untitled', 'Senza titolo', 'pista 12', 'Mia canzone', 'Kokoro', 'Track of my life', '夜に駆ける', '123']) {
    same('junkTitle', s)
    same('usableTitle', s)
  }
  for (const [a, b] of [
    ['÷', '÷'], ['( )', '( )'], ['+', '+ - Single'], ['7', '7 - EP'], ['Up', 'Up - EP'], ['XO', 'XO - Single'], ['25', '25 (Single)'],
    ['Disco', 'Disco (Deluxe Edition)'], ['Disco', 'Disco Deluxe Edition'], ['Abbey Road', 'Abbey Road - Remastered 2009'],
    ['Nevermind', 'Nevermind 20th Anniversary Edition'], ['THE BOOK', 'the book'], ['夜に駆ける', '夜に駆ける - Single'], ['夜に駆ける', '夜に駆ける (初回限定盤)'],
    ['Live', 'Alive'], ['Live', 'Oliver!'], ['Rain', 'Brain Damage'], ['Greatest Hits', 'Greatest Hits Vol. 2'], ['Led Zeppelin', 'Led Zeppelin II'],
    ['Blue', 'Blue Regret'], ['THE BOOK', 'THE BOOK 2'], ['÷', '×'], ['÷', 'Divide'], ['ブルー', 'ブルーリグレット'], ['夜に駆ける', '夜に駆けるデラックス']
  ]) {
    same('albumsMatch', a, b)
    same('releaseFits', { title: a }, b)
  }
  for (const h of [
    { title: '03 - Artista - Titolo', artist: 'Artista sconosciuto', tagless: ['title', 'artist'], edited: [] },
    { title: 'A - B - Titolo', artist: 'Artista sconosciuto', tagless: ['title', 'artist'], edited: [] },
    { title: 'X - Titolo', artist: 'Tag', tagless: ['title'], edited: [] },
    { title: '07. Kokoro', artist: 'Artista sconosciuto', tagless: ['title', 'artist'], edited: [] },
    { id: 'c269bd096503b57b53fadd68', title: 'c269bd096503b57b53fadd68', artist: 'Artista sconosciuto', tagless: ['title', 'artist'], edited: [] }
  ]) same('hintsOf', h)
  same('searchQuery', { title: 'Say "Hi" \\ now', artist: null }, 200000)
  const versionsRec = (id, score, title) => ({ id, score, title, length: 200000, 'artist-credit': [{ name: 'X' }] })
  const answer = { recordings: [versionsRec('live', 100, 'Canzone Bella (live)'), versionsRec('plain', 95, 'Canzone Bella')] }
  same('chooseFromSearch', answer, { title: 'Canzone Bella', artist: null }, 200000)
  same('chooseFromSearch', answer, { title: 'Canzone Bella (Live)', artist: null }, 200000)
  for (const name of ['aizo', 'shinu', 'yoru']) {
    const rec = JSON.parse(read('test/fixtures/details/mb-recording-' + name + '.json'))
    for (const hint of [null, 'AIZO', 'Yoru ni Kakeru', '夜に駆ける', 'Nessuno']) {
      same('chooseRelease', rec.releases, hint)
      const chosen = details.chooseRelease(rec.releases, hint)
      same('releaseFits', chosen, hint, rec.releases)
      same('valuesOf', rec, chosen, null)
    }
  }
})

test('details constants: the source\'s pace, back-off, retries and caches; the phone asks MusicBrainz and the Cover Art Archive once every 3 s', () => {
  assert.deepEqual(rules.PACE, { musicbrainz: details.PACE.musicbrainz, caa: details.PACE.caa })
  assert.deepEqual(rules.PHONE_PACE, { musicbrainz: 3000, caa: 3000 })
  assert.deepEqual(rules.DETAILS_BACKOFF, constOf('server/details.mjs', 'BACKOFF'))
  assert.equal(rules.THROTTLED_FAIL, constOf('server/details.mjs', 'THROTTLED_FAIL'))
  assert.equal(rules.FILL_DELAY_MS, constOf('server/details.mjs', 'FILL_DELAY_MS'))
  assert.equal(rules.DETAILS_RETRY_BASE_MS, constOf('server/details.mjs', 'RETRY_BASE_MS'))
  assert.equal(rules.DETAILS_MAX_TRIES, constOf('server/details.mjs', 'MAX_TRIES'))
  assert.deepEqual(rules.OFFLINE_PAUSE, constOf('server/details.mjs', 'OFFLINE_PAUSE'))
  assert.deepEqual(rules.OFFLINE_PAUSE, constOf('server/lyrics.mjs', 'OFFLINE_PAUSE'))
  assert.equal(rules.CAA_KEEP, constOf('server/details.mjs', 'CAA_KEEP'))
  assert.equal(rules.RELEASE_PAGE, constOf('server/details.mjs', 'RELEASE_PAGE'))
  assert.equal(rules.RELEASE_PAGES, constOf('server/details.mjs', 'RELEASE_PAGES'))
  assert.deepEqual(rules.LOOKUP_FIELDS, constOf('server/details.mjs', 'LOOKUP_FIELDS'))
  assert.equal(rules.MB_URL, details.DETAILS_URLS.musicbrainz)
  assert.equal(rules.CAA_URL, details.DETAILS_URLS.caa)
  assert.equal(rules.LRCLIB_URL, lyrics.LRCLIB_URL)
  assert.equal(rules.LYRICS_PACE_MS, lyrics.PACE_MS)
  assert.deepEqual(rules.LYRICS_BACKOFF, [...lyrics.BACKOFF])
  assert.equal(rules.MAX_RETRY_AFTER_MS, lyrics.MAX_RETRY_AFTER_MS)
  assert.equal(rules.LYRICS_RETRY_BASE_MS, lyrics.RETRY_BASE_MS)
  assert.equal(rules.LYRICS_MAX_TRIES, lyrics.MAX_TRIES)
  assert.equal(rules.MISS_RETRY_MS, lyrics.MISS_RETRY_MS)
  assert.equal(rules.userAgentOf('1.0.0'), details.userAgentOf('1.0.0'))
})

test('the pacer: a start at least the interval after the previous start and its answer; 429 and 503 pause 5, 10, 20, 40, 60 s until a normal answer', async () => {
  let now = 1000
  const waits = []
  const pacer = new rules.Pacer(3000, rules.DETAILS_BACKOFF, { now: () => now, wait: async (ms) => { waits.push(ms); now += ms } })
  await pacer.slot()
  assert.deepEqual(waits, [], 'the first goes at once')
  now += 500 // the answer took 0.5 s
  pacer.done()
  await pacer.slot()
  assert.deepEqual(waits, [3000], 'counted from the answer')
  pacer.done()
  now += 4000
  await pacer.slot()
  assert.deepEqual(waits, [3000], 'enough time went by')
  for (let i = 0; i < 6; i++) pacer.throttled()
  const at = now
  await pacer.slot()
  assert.equal(now - at, 60000, 'the pause is capped at 60 s')
  pacer.calm()
  pacer.throttled()
  const at2 = now
  await pacer.slot()
  assert.equal(now - at2, 5000, 'a normal answer starts the back-off over')
})

// -------------------------------------------------------------- the lyrics rules

test('lyrics rules: the key, who may be asked, the query and Retry-After are the source\'s (generated vectors)', () => {
  const r = rng(31)
  const now = Date.parse('2026-11-22T10:00:00Z')
  for (let n = 0; n < 400; n++) {
    const t = {
      id: n.toString(16).padStart(24, '0'),
      title: r() < 0.05 ? n.toString(16).padStart(24, '0') : pick(r, ['', text(r), 'Canzone & "virgolette" + più', 'a b', 'x~y*z(1)!\'', '\ud800 sola']),
      artist: pick(r, ['', 'Artista sconosciuto', text(r, 2), 'Röyksopp']),
      album: pick(r, ['', 'Album sconosciuto', text(r, 2)]),
      duration: pick(r, [null, 0, -3, 59.4, 59.5, 3600.4, 3600.6, 241.371, NaN, Infinity])
    }
    assert.equal(rules.keyOf(t), lyrics.keyOf(t), JSON.stringify(t))
    assert.equal(rules.askable(t), lyrics.askable(t), JSON.stringify(t))
    if (lyrics.askable(t) || typeof t.duration === 'number') assert.equal(rules.queryOf(t), lyrics.queryOf(t), JSON.stringify(t))
  }
  for (const v of [null, '', ' ', '0', '7', '120', '99999999999', '3600', '3601', 'Wed, 21 Oct 2015 07:28:00 GMT', new Date(now + 90000).toUTCString(), 'domani', '-5', '1.5']) {
    assert.equal(rules.retryAfterMs(v, now), lyrics.retryAfterMs(v, now), String(v))
  }
})
