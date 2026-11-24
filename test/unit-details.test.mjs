// Details from the network with fake AcoustID, MusicBrainz and Cover Art Archive
// servers (test/fake-services.mjs) and a fake fpcalc: the recorded real answers
// (test/fixtures/details), the choice rules, the text search, the release, the
// cover, what is written and what never is, pacing, backoff, retries, the
// switch and the key; the owner's API and the CLI.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createMPfy } from '../server/app.mjs'
import { runCommand } from '../server/index.mjs'
import { albumIdOf } from '../server/ids.mjs'
import {
  compressFingerprint, norm, textsMatch, hintsOf, junkTitle, usableTitle, missingFields, wantsLookup, acoustidCandidates, chooseRecording,
  chooseRelease, releaseFits, searchQuery, chooseFromSearch, artistText, ACOUSTID_KEY, Details
} from '../server/details.mjs'
import { Library, normalizeTrack } from '../server/library.mjs'
import { saveCoverBytes, UNKNOWN_ALBUM } from '../server/media.mjs'
import { tmpDir, cleanup, request, json, makeWav, makeMp3, makeZip, fakePng, makeProfile, device, testWhoIs, fakeTool, fakeFfmpeg, hash24, fingerprintOf, waitFor } from './helpers.mjs'
import { fakeServices } from './fake-services.mjs'

const body = (r) => json(r)
const fixture = (name) => JSON.parse(fs.readFileSync(new URL('./fixtures/details/' + name + '.json', import.meta.url), 'utf8'))
const UA = 'MPfy/' + JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version + ' ( https://github.com/BaccaranciaSte/MPfy )'
const FAST = { acoustid: 0, musicbrainz: 0, caa: 0 }
const REC = {
  shinu: 'a97992ca-5d3d-4ce9-bab1-e631360c618b',
  aizo: '4c819955-e6b3-491a-b951-f9a766db02ac',
  yoru: '57a6dff3-daee-4e63-bc82-6bd6f5df2957'
}
const RELEASE = { shinu: '04031da3-2d5e-4d56-9bfd-9d3acbc1d842', aizo: '77865dc9-f253-4aee-b8ed-f7bd5b36bbde', yoru: '1489b651-808d-465b-b92e-15fee371a158' }
const GROUP = { aizo: '350f4cb8-e5cd-42ea-b7aa-047eb1553620', yoru: '6ddc7e3d-6fc7-4859-9e35-b666e49b40f5' }
// 夜に駆ける: the first single (its group holds the pseudo-releases "Yoru ni Kakeru"
// and "Racing Into The Night") and the instrumental recording.
const SINGLE_YORU = '9e3992c7-06d1-4314-8e5c-504992660c8b'
const INSTRUMENTAL_YORU = '05add9fc-94b5-4737-be35-72a7b75a0266'
// 死ぬのがいいわ on a Various Artists compilation (track 10).
const COMPILATION = 'd2dbb73c-1a78-4e02-be12-3abc16574062'
const INC = '?inc=releases+release-groups+media+artist-credits&fmt=json'

// A JPEG small enough to be a test cover.
function jpeg (seed) {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.from('JFIF\0' + seed.padEnd(9, '.')), Buffer.from([0xff, 0xd9])])
}

// A song of `seconds` (a 1 kHz WAV: small, its length exact), with optional tags.
function song (seconds, freq, tags = null) {
  return makeWav({ seconds, sampleRate: 1000, freq, tags })
}

async function start (t, { svc = null, fp = {}, ff = null, dir = null, opts = {}, profile = null } = {}) {
  const c = cleanup(t)
  const dataDir = dir || c.dir(tmpDir())
  const work = c.dir(tmpDir('mpfy-details-'))
  const fpcalc = fakeTool(work, 'fpcalc', fp)
  const ffmpeg = ff === null ? null : fakeFfmpeg(work, ff).command
  const services = svc || await fakeServices()
  const app = c.close(await createMPfy({
    dataDir, port: 0, adminPort: 0, p2p: false, debounceMs: 10, ffmpeg, fpcalc: fpcalc.command, sevenZip: null, whoIs: testWhoIs,
    detailsUrls: services.urls, detailsFillDelayMs: 50, detailsPace: FAST, detailsPollMs: 100, detailsGenres: false, ...opts
  }))
  if (svc === null) c.close(services)
  await app.jobsStarted
  if (profile === null) app.people.openClaim(30)
  const owner = device(app, { profile: profile || makeProfile(), name: 'Bacca' })
  assert.equal(body(await owner.call('GET', '/api/profile')).role, 'owner')
  const upload = async (name, buf, who = owner) => {
    const r = await who.call('PUT', '/api/upload/' + encodeURIComponent(name), { body: buf })
    assert.equal(r.status, 200, r.body.toString())
    return body(r).track
  }
  return { app, dir: dataDir, owner, svc: services, fpcalc, upload }
}

// Prints for the fake fpcalc and the AcoustID answers they get.
function printsOf (list) {
  const prints = {}
  for (const { buf, seed, duration } of list) prints[hash24(buf)] = { duration, fingerprint: fingerprintOf(seed) }
  return prints
}
const compressed = (seed) => compressFingerprint(Uint32Array.from(fingerprintOf(seed)))

const settled = (app, id) => waitFor(() => {
  const t = app.library.getTrack(id)
  return t && t.lookup ? t : null
}, { what: 'the lookup of ' + id })

// ------------------------------------------------------------- the rules

test('text rules: norm, matching, junk titles, hints; artist credits', () => {
  assert.equal(norm('Archive (feat. stb & Sasa.)'), 'archive')
  assert.equal(norm('Song feat. Someone Else'), 'song')
  assert.equal(norm('【MV】夜に駆ける [Official]'), '夜に駆ける')
  assert.equal(norm('ＡＩＺＯ（Live）'), 'aizo')
  assert.equal(textsMatch('aizo', 'aizo'), true)
  assert.equal(textsMatch('夜に駆ける', '夜に駆けるinstrumental'), true, 'the shorter has 5 characters')
  assert.equal(textsMatch('abc', 'abcdef'), false, 'the shorter needs 4 characters')
  assert.equal(textsMatch('', ''), false)
  for (const junk of ['traccia02', 'Track 7', '01 - traccia03', 'Audio', 'untitled', 'Senza titolo', 'pista 12']) assert.equal(junkTitle(junk), true, junk)
  for (const real of ['Mia canzone', 'Kokoro', 'Track of my life', '夜に駆ける']) assert.equal(junkTitle(real), false, real)
  assert.equal(usableTitle('123'), false, 'no letter')
  assert.equal(usableTitle('traccia01'), false)
  assert.deepEqual(hintsOf({ title: '03 - Artista - Titolo', artist: 'Artista sconosciuto', tagless: ['title', 'artist'], edited: [] }), { title: 'Titolo', artist: 'Artista', usable: true })
  assert.deepEqual(hintsOf({ title: 'A - B - Titolo', artist: 'Artista sconosciuto', tagless: ['title', 'artist'], edited: [] }), { title: 'Titolo', artist: 'A - B', usable: true }, 'split at the last " - "')
  assert.deepEqual(hintsOf({ title: 'X - Titolo', artist: 'Tag', tagless: ['title'], edited: [] }), { title: 'X - Titolo', artist: 'Tag', usable: true }, 'an artist tag: the title stays whole')
  assert.deepEqual(hintsOf({ title: '07. Kokoro', artist: 'Artista sconosciuto', tagless: ['title', 'artist'], edited: [] }), { title: 'Kokoro', artist: null, usable: true })
  const id = 'c269bd096503b57b53fadd68'
  assert.equal(hintsOf({ id, title: id, artist: 'Artista sconosciuto', tagless: ['title', 'artist'], edited: [] }).usable, false, 'the track id is no title (a file found in library/)')
  assert.equal(hintsOf({ id: 'a'.repeat(24), title: '3f0e9a1b2c4d5e6f7a8b9c0d', artist: 'Artista sconosciuto', tagless: ['title', 'artist'], edited: [] }).usable, false, 'nor is a content hash')
  assert.equal(artistText([{ name: 'A', joinphrase: ' & ' }, { name: 'B' }]), 'A & B')
  assert.equal(artistText([{ name: 'A' }, { name: 'B' }, { name: 'C' }]), 'A, B, C', 'no join phrase: a comma between two names')
  assert.equal(searchQuery({ title: 'Say "Hi" \\ now', artist: null }, 200000), 'recording:"Say \\"Hi\\" \\\\ now" AND dur:[197000 TO 203000]')
  assert.equal(searchQuery({ title: 'T', artist: 'A' }, 5000), 'recording:"T" AND artist:"A" AND dur:[2000 TO 8000]')
})

test('missing fields: tagless and never edited; a track from before gets only a junk title; album artist and disc ride along; the cover looks at custom covers', () => {
  const all = ['title', 'artist', 'albumArtist', 'album', 'year', 'trackNo', 'discNo', 'cover']
  const t = { id: 'a'.repeat(24), title: 'traccia02', artist: 'Artista sconosciuto', albumArtist: 'Artista sconosciuto', album: 'Album sconosciuto', year: null, trackNo: null, discNo: null, coverId: null, tagless: all, edited: [] }
  assert.deepEqual(missingFields(t), ['title', 'artist', 'albumArtist', 'album', 'year', 'trackNo', 'cover'], 'disc only with a track number of this lookup')
  const values = { title: 'X', artist: 'Y', album: 'Z', albumArtist: 'W', year: 2020, trackNo: 3, discNo: 1 }
  assert.deepEqual(missingFields(t, values), all)
  assert.deepEqual(missingFields({ ...t, edited: ['title', 'album'] }, values), ['artist', 'albumArtist', 'year', 'trackNo', 'discNo', 'cover'])
  assert.deepEqual(missingFields({ ...t, tagless: ['title'] }, values), ['title'], 'tags are never overwritten')
  assert.deepEqual(missingFields({ ...t, tagless: null }, values), [], 'a track from before whose tags were not read yet')
  const before = { ...t, title: 'Mia canzone', editedUnknown: true }
  assert.equal(missingFields(before, values).includes('title'), false, 'a title a person may have typed')
  assert.equal(missingFields({ ...before, title: '05 Traccia 5' }, values).includes('title'), true)
  assert.equal(missingFields({ ...t, albumArtist: 'Qualcuno', album: 'Un album' }, values).includes('albumArtist'), false)
  assert.equal(missingFields({ ...t, albumArtist: 'Qualcuno' }, values).includes('albumArtist'), true, 'the album is filled now: its artist too')
  // Custom covers: of the track, or of the album it will be in after this lookup.
  const custom = (kind, id) => (kind === 'track' && id === t.id) || (kind === 'album' && id === 'b2e6d2cc0c1e5e18')
  assert.equal(missingFields(t, values, custom).includes('cover'), false)
  assert.equal(wantsLookup({ ...t, tagless: ['year', 'trackNo', 'discNo'] }), false, 'only riders missing: no lookup')
  assert.equal(wantsLookup({ ...t, tagless: ['cover'] }), true)
})

test('AcoustID choice: the recorded answers; rule 1 needs 0.85, plausible sources and the length; a low score is never taken by it', () => {
  const pick = (name, title, duration) => chooseRecording(acoustidCandidates(fixture('acoustid-' + name)), {
    duration, hints: hintsOf({ title, artist: 'Artista sconosciuto', tagless: ['title', 'artist'], edited: [] })
  })
  let r = pick('traccia02', 'traccia02', 185.6)
  assert.deepEqual([r.kind, r.rule, r.candidate.id, r.candidate.sources], ['take', 1, REC.shinu, 74], 'the same recording in two results: sources summed')
  r = pick('traccia03', 'traccia03', 215.9)
  assert.deepEqual([r.kind, r.rule, r.candidate.title, r.candidate.artist], ['take', 1, 'AIZO', 'King Gnu'], 'Kehrääjä (9 sources) is not plausible next to 57')
  assert.equal(pick('traccia01', 'traccia01', 259.58).kind, 'ambiguous', 'best score 0.595 and no usable name')
  r = pick('traccia01', '夜に駆ける', 259.58)
  assert.deepEqual([r.kind, r.rule, r.candidate.id, r.candidate.artist, r.candidate.sources], ['take', 2, REC.yoru, 'YOASOBI', 167])
  assert.equal(pick('traccia02', 'traccia02', 190).kind, 'ambiguous', 'more than 3 s apart: not the same length')
  const synthetic = { status: 'ok', results: [
    { id: 'r1', score: 0.95, recordings: [{ id: 'X', title: 'Ics', duration: 200, sources: 2, artists: [{ name: 'A' }] }] },
    { id: 'r2', score: 0.6, recordings: [{ id: 'Y', title: 'Ipsilon', duration: 200, sources: 100, artists: [{ name: 'B' }] }] },
    { id: 'r3', score: 0.4, recordings: [{ id: 'Z', title: 'Zeta', duration: 200, sources: 1000, artists: [{ name: 'C' }] }] },
    { id: 'r4', score: 0.9, recordings: [{ id: 'N', duration: 200, sources: 5 }] }
  ] }
  const cands = acoustidCandidates(synthetic)
  assert.deepEqual(cands.map((c) => c.id), ['X', 'Y'], 'under 0.5, or without title and artist: not candidates')
  r = chooseRecording(cands, { duration: 201, hints: { title: 'x', artist: null, usable: false } })
  assert.deepEqual([r.kind, r.candidate.id], ['take', 'X'])
  r = chooseRecording(cands.filter((c) => c.id === 'Y'), { duration: 201, hints: { title: 'x', artist: null, usable: false } })
  assert.equal(r.kind, 'ambiguous', 'Y alone at 0.6 is never taken by rule 1')
  assert.equal(chooseRecording([], { duration: 1, hints: {} }).kind, 'none')
})

test('the release: official first, the album tag wins, else album over EP over single over the rest, then the earliest, then the smallest id', () => {
  const rel = (id, title, status, date, type, secondary = []) => ({ id, title, status, date, 'release-group': { 'primary-type': type, 'secondary-types': secondary } })
  const list = [
    rel('5', 'Singolo', 'Official', '2019-01-01', 'Single'),
    rel('4', 'Raccolta', 'Official', '2017', 'Album', ['Compilation']),
    rel('3', 'Disco', 'Official', '2020-02-02', 'Album'),
    rel('2', 'Disco', 'Bootleg', '2016', 'Album'),
    rel('6', 'Disco', 'Official', undefined, 'Album'),
    rel('1', 'Disco EP', 'Official', '2018', 'EP')
  ]
  assert.equal(chooseRelease(list).id, '3', 'an official album, dated, over single and compilation')
  assert.equal(chooseRelease(list, 'singolo').id, '5', 'the album tag wins')
  assert.equal(chooseRelease(list, 'Nessuno').id, '3')
  assert.equal(chooseRelease([list[3], rel('7', 'X', 'Promotion', '2015', 'Single')]).id, '2', 'no official release: the others')
  assert.equal(chooseRelease([rel('b', 'A', 'Official', '2020', 'Album'), rel('a', 'A', 'Official', '2020', 'Album')]).id, 'a')
  assert.equal(chooseRelease([rel('a', 'A', 'Official', undefined, 'Album'), rel('b', 'A', 'Official', '2021', 'Album')]).id, 'b', 'no date last')
  assert.equal(chooseRelease([rel('a', 'A', 'Official', '2020', 'EP'), rel('b', 'A', 'Official', '2021', 'Single')]).id, 'a')
  assert.equal(chooseRelease([]), null)
})

test('text search answers: score 90, length within 3 s, the exact title, one artist credit', () => {
  const rec = (id, score, title, length, artist) => ({ id, score, title, length, 'artist-credit': [{ name: artist }] })
  const hints = { title: 'Canzone Bella', artist: null }
  assert.equal(chooseFromSearch({ recordings: [rec('a', 100, 'Canzone Bella', 201000, 'X'), rec('b', 95, 'Canzone bella!', 199000, 'X')] }, hints, 200000).id, 'a')
  assert.equal(chooseFromSearch({ recordings: [rec('a', 100, 'Canzone Bella', 203100, 'X')] }, hints, 200000), null, '3.1 s off')
  assert.equal(chooseFromSearch({ recordings: [rec('a', 89, 'Canzone Bella', 200000, 'X')] }, hints, 200000), null, 'score under 90')
  assert.equal(chooseFromSearch({ recordings: [rec('a', 95, 'Canzone Bella (live)', 200000, 'X'), rec('b', 100, 'Canzone Bella', 200000, 'X')] }, hints, 200000).id, 'b', 'brackets aside, equal; one credit: the highest score')
  assert.equal(chooseFromSearch({ recordings: [rec('a', 100, 'Canzone Bella', 200000, 'X'), rec('b', 100, 'Canzone Bella', 200000, 'Y')] }, hints, 200000), null, 'two artists')
  assert.equal(chooseFromSearch({ recordings: [rec('a', 100, 'Canzone Bella Lunga', 200000, 'X')] }, hints, 200000), null, 'contained is not equal here')
  assert.equal(chooseFromSearch({ recordings: [rec('a', 100, 'Canzone Bella', 200000, 'Altro')] }, { ...hints, artist: 'Artista' }, 200000), null)
})

test('a name names its version: "夜に駆ける (instrumental)" is the instrumental, never the sung one with more sources; the text search the same', () => {
  const cands = acoustidCandidates(fixture('acoustid-traccia01'))
  const hints = (title) => hintsOf({ title, artist: 'Artista sconosciuto', tagless: ['title', 'artist'], edited: [] })
  let r = chooseRecording(cands, { duration: 259.58, hints: hints('夜に駆ける (instrumental)') })
  assert.deepEqual([r.kind, r.rule, r.candidate.id, r.candidate.title], ['take', 2, INSTRUMENTAL_YORU, '夜に駆ける (instrumental)'])
  assert.equal(chooseRecording(cands, { duration: 259.58, hints: hints('夜に駆ける (Live)') }).kind, 'ambiguous', 'no live take among them')
  r = chooseRecording(cands, { duration: 259.58, hints: hints('夜に駆ける') })
  assert.deepEqual([r.kind, r.candidate.id], ['take', REC.yoru], 'the plain title: the sung one')
  const rec = (id, score, title) => ({ id, score, title, length: 200000, 'artist-credit': [{ name: 'X' }] })
  const answer = { recordings: [rec('live', 100, 'Canzone Bella (live)'), rec('plain', 95, 'Canzone Bella')] }
  assert.equal(chooseFromSearch(answer, { title: 'Canzone Bella', artist: null }, 200000).id, 'plain')
  assert.equal(chooseFromSearch(answer, { title: 'Canzone Bella (Live)', artist: null }, 200000).id, 'live')
})

test('album titles: word by word, an edition only by edition words; a title of signs as it is written; a store\'s " - EP" aside', () => {
  for (const [a, b] of [
    ['÷', '÷'], ['( )', '( )'], ['+', '+ - Single'], ['7', '7 - EP'], ['Up', 'Up - EP'], ['XO', 'XO - Single'], ['25', '25 (Single)'],
    ['Disco', 'Disco (Deluxe Edition)'], ['Disco', 'Disco Deluxe Edition'], ['Abbey Road', 'Abbey Road - Remastered 2009'],
    ['Nevermind', 'Nevermind 20th Anniversary Edition'], ['THE BOOK', 'the book'], ['夜に駆ける', '夜に駆ける - Single'], ['夜に駆ける', '夜に駆ける (初回限定盤)']
  ]) assert.ok(releaseFits({ title: a }, b) && releaseFits({ title: b }, a), a + ' | ' + b)
  for (const [a, b] of [
    ['Live', 'Alive'], ['Live', 'Oliver!'], ['Rain', 'Brain Damage'], ['Greatest Hits', 'Greatest Hits Vol. 2'], ['Led Zeppelin', 'Led Zeppelin II'],
    ['Blue', 'Blue Regret'], ['THE BOOK', 'THE BOOK 2'], ['÷', '×'], ['÷', 'Divide'], ['ブルー', 'ブルーリグレット'], ['夜に駆ける', '夜に駆けるデラックス']
  ]) assert.ok(!releaseFits({ title: a }, b) && !releaseFits({ title: b }, a), a + ' | ' + b)
  const rel = (id, title, type) => ({ id, title, status: 'Official', date: '2020', 'release-group': { id: 'g-' + id, title, 'primary-type': type, 'secondary-types': [] } })
  assert.equal(chooseRelease([rel('a', 'Divide Tour', 'Album'), rel('b', '÷', 'Single')], '÷').id, 'b')
  assert.equal(chooseRelease([rel('a', 'Seven', 'Album'), rel('b', '7', 'EP')], '7 - EP').id, 'b')
  const alive = chooseRelease([rel('a', 'Alive II', 'Album'), rel('b', 'Greatest Hits Vol. 2', 'Album')], 'Live')
  assert.ok(!releaseFits(alive, 'Live'), 'no release of that album: none fits')
})

test('the compressed fingerprint: algorithm, count, gaps in 3 bits with exceptions in 5', () => {
  // 0b1001: gaps 1 and 3, then 0. 0b1001 ^ 0b1000_0000_0001 = 0b1000_0000_1000: gaps 4 and 8 (7 + 1).
  // That ^ 0b1000_0001: bits 1 and 8: gaps 1 and 7 (7 + 0).
  const items = [0b1001, 0b100000000001, 0b100000000001 ^ 0b10000001]
  const fp = compressFingerprint(items, 1)
  const buf = Buffer.from(fp, 'base64url')
  assert.deepEqual([...buf.subarray(0, 4)], [1, 0, 0, 3])
  // 3-bit values packed LSB first.
  const normal = [1, 3, 0, 4, 7, 0, 1, 7, 0]
  let v = 0n
  normal.forEach((b, i) => { v |= BigInt(b) << BigInt(3 * i) })
  const bytes = Math.ceil(normal.length * 3 / 8)
  assert.deepEqual([...buf.subarray(4, 4 + bytes)], Array.from({ length: bytes }, (_, i) => Number((v >> BigInt(8 * i)) & 0xffn)))
  // The exceptions 1 (8 - 7) and 0 (7 - 7), 5 bits each.
  assert.deepEqual([...buf.subarray(4 + bytes)], [1, 0])
  assert.ok(!fp.includes('=') && !fp.includes('+') && !fp.includes('/'))
})

// -------------------------------------------------------------- the source

test('details: the recorded cases: 死ぬのがいいわ and AIZO by rule 1, 夜に駆ける as traccia01 ambiguous and by its name YOASOBI; release, year, track, disc and cover; exactly what leaves', async (t) => {
  const files = {
    shinu: song(185.6, 101),
    aizo: song(215.9, 103),
    yoru: song(259.58, 107),
    yoruNamed: song(259.58, 109)
  }
  const fp = { prints: printsOf([{ buf: files.shinu, seed: 'shinu', duration: 185.6 }, { buf: files.aizo, seed: 'aizo', duration: 215.9 }, { buf: files.yoru, seed: 'yoru', duration: 259.58 }, { buf: files.yoruNamed, seed: 'yoru2', duration: 259.58 }]) }
  const svc = await fakeServices()
  svc.answers.acoustid = {
    [compressed('shinu')]: fixture('acoustid-traccia02'),
    [compressed('aizo')]: fixture('acoustid-traccia03'),
    [compressed('yoru')]: fixture('acoustid-traccia01'),
    [compressed('yoru2')]: fixture('acoustid-traccia01')
  }
  svc.answers.mb = { ['recording/' + REC.shinu]: fixture('mb-recording-shinu'), ['recording/' + REC.aizo]: fixture('mb-recording-aizo'), ['recording/' + REC.yoru]: fixture('mb-recording-yoru') }
  const coverShinu = jpeg('shinu')
  const coverAizo = jpeg('aizo')
  svc.answers.caa = { ['release/' + RELEASE.shinu]: coverShinu, ['release-group/' + GROUP.aizo]: coverAizo }
  const { app, upload, fpcalc } = await start(t, { svc, fp })
  cleanup(t).close(svc)

  const shinu = await upload('traccia02.wav', files.shinu)
  const aizo = await upload('traccia03.wav', files.aizo)
  const yoru = await upload('traccia01.wav', files.yoru)
  const yoruNamed = await upload('夜に駆ける.wav', files.yoruNamed)
  await app.details.idle()

  let tr = app.library.getTrack(shinu.id)
  assert.deepEqual([tr.title, tr.artist, tr.album, tr.albumArtist, tr.year, tr.trackNo, tr.discNo], ['死ぬのがいいわ', '藤井風', 'HELP EVER HURT NEVER', '藤井風', 2020, 8, 1])
  assert.ok(tr.coverId && fs.existsSync(path.join(app.library.coversDir, tr.coverId + '.jpg')), 'the cover stored as an embedded one')
  assert.deepEqual({ ...tr.lookup, at: 0 }, { v: 1, state: 'applied', at: 0, tries: 1, fileHash: shinu.id, acoustid: '7e52f5a7-5658-4fe6-bece-860a18751ea9', recording: REC.shinu, release: RELEASE.shinu, filled: ['title', 'artist', 'albumArtist', 'album', 'year', 'trackNo', 'discNo', 'cover'] })
  tr = app.library.getTrack(aizo.id)
  assert.deepEqual([tr.title, tr.artist, tr.album, tr.albumArtist, tr.year, tr.trackNo, tr.discNo, tr.lookup.release], ['AIZO', 'King Gnu', 'AIZO', 'King Gnu', 2026, 1, 1, RELEASE.aizo])
  assert.ok(tr.coverId !== null, 'the release has none: its release group')
  tr = app.library.getTrack(yoru.id)
  assert.deepEqual([tr.title, tr.artist, tr.lookup.state, tr.lookup.recording, tr.lookup.filled], ['traccia01', 'Artista sconosciuto', 'ambiguous', null, []])
  tr = app.library.getTrack(yoruNamed.id)
  assert.deepEqual([tr.title, tr.artist, tr.album, tr.year, tr.trackNo, tr.coverId, tr.lookup.state], ['夜に駆ける', 'YOASOBI', 'THE BOOK', 2021, 8, null, 'applied'])
  assert.equal(tr.lookup.filled.includes('cover'), false, 'no cover for the release nor its group')

  // What left the source.
  const ac = svc.of('acoustid')
  assert.equal(ac.length, 4)
  assert.deepEqual(ac.map((r) => r.body), [
    'client=' + ACOUSTID_KEY + '&format=json&meta=recordings+sources&duration=186&fingerprint=' + compressed('shinu'),
    'client=' + ACOUSTID_KEY + '&format=json&meta=recordings+sources&duration=216&fingerprint=' + compressed('aizo'),
    'client=' + ACOUSTID_KEY + '&format=json&meta=recordings+sources&duration=260&fingerprint=' + compressed('yoru'),
    'client=' + ACOUSTID_KEY + '&format=json&meta=recordings+sources&duration=260&fingerprint=' + compressed('yoru2')
  ], 'the fingerprint compressed from the stored raw one, and the duration: nothing else')
  for (const r of ac) {
    assert.equal(r.method, 'POST')
    assert.equal(r.headers['content-type'], 'application/x-www-form-urlencoded')
  }
  assert.equal(fpcalc.calls().filter((c) => c.args.length && !c.args.includes('-raw') && !c.args.includes('-version')).length, 0, 'fpcalc not run again: the .fp was there')
  assert.deepEqual(svc.of('musicbrainz').map((r) => r.path + r.query), [
    '/ws/2/recording/' + REC.shinu + INC, '/ws/2/recording/' + REC.aizo + INC, '/ws/2/recording/' + REC.yoru + INC
  ], 'traccia01 never reached MusicBrainz')
  assert.deepEqual(svc.of('caa').map((r) => r.path), [
    '/release/' + RELEASE.shinu + '/front-500', '/release/' + RELEASE.aizo + '/front-500', '/release-group/' + GROUP.aizo + '/front-500',
    '/release/' + RELEASE.yoru + '/front-500', '/release-group/' + GROUP.yoru + '/front-500'
  ])
  for (const r of svc.requests) {
    assert.equal(r.headers['user-agent'], UA, r.service + ' ' + r.path)
    if (r.service === 'musicbrainz') assert.equal(r.headers.accept, 'application/json')
    const seen = JSON.stringify(r)
    for (const secret of [app.name, app.serverPublicKey, 'traccia', path.basename(app.library.dataDir)]) assert.ok(!seen.includes(secret), r.service + ' got ' + secret)
  }
  const health = await request(app.ports.admin, 'GET', '/admin/health')
  assert.deepEqual(body(health).details, { enabled: true, queued: 0, applied: 3, nothing: 0, ambiguous: 1, failed: 0, acoustidKeyValid: true })
  assert.equal(body(await request(app.ports.http, 'GET', '/api/health')).details, true)
})

test('details: the text search: one match within 3 s applied; 3.1 s off, two artists and a junk name never applied, a junk name never sent', async (t) => {
  const a = song(200, 111)
  const b = song(200, 113)
  const c = song(200, 117)
  const d = song(200, 119)
  // No fingerprint for any of them (fpcalc fails): straight to the text search.
  const svc = await fakeServices()
  const queries = []
  svc.answers.mbSearch = (q) => {
    queries.push(q)
    const rec = (id, length, artist) => ({ id, score: 100, title: q.includes('Lontana') ? 'Canzone Lontana' : q.includes('Doppia') ? 'Canzone Doppia' : 'Canzone Bella', length, 'artist-credit': [{ name: artist }] })
    if (q.includes('Bella')) return { recordings: [rec('rb', 201500, 'Artista Uno')] }
    if (q.includes('Lontana')) return { recordings: [rec('rl', 203100, 'Artista Due')] }
    return { recordings: [rec('d1', 200000, 'Uno'), rec('d2', 200000, 'Due')] }
  }
  svc.answers.mb = { 'recording/rb': { id: 'rb', title: 'Canzone Bella', length: 201500, 'artist-credit': [{ name: 'Artista Uno', joinphrase: '' }], releases: [] } }
  const fp = { fail: [hash24(a), hash24(b), hash24(c), hash24(d)] }
  const { app, upload } = await start(t, { svc, fp })
  cleanup(t).close(svc)
  const ta = await upload('Artista Uno - Canzone Bella.wav', a)
  const tb = await upload('Artista Due - Canzone Lontana.wav', b)
  const tc = await upload('Canzone Doppia.wav', c)
  const td = await upload('traccia05.wav', d)
  await app.details.idle()
  assert.equal(svc.of('acoustid').length, 0, 'no fingerprint: AcoustID is not asked')
  assert.deepEqual(queries, [
    'recording:"Canzone Bella" AND artist:"Artista Uno" AND dur:[197000 TO 203000]',
    'recording:"Canzone Lontana" AND artist:"Artista Due" AND dur:[197000 TO 203000]',
    'recording:"Canzone Doppia" AND dur:[197000 TO 203000]'
  ], 'the junk name is never sent')
  let tr = app.library.getTrack(ta.id)
  assert.deepEqual([tr.title, tr.artist, tr.lookup.state, tr.lookup.recording], ['Canzone Bella', 'Artista Uno', 'applied', 'rb'])
  for (const x of [tb, tc, td]) {
    tr = app.library.getTrack(x.id)
    assert.deepEqual([tr.artist, tr.lookup.state, tr.lookup.recording], ['Artista sconosciuto', 'nothing', null], tr.title)
  }
  assert.deepEqual(svc.of('musicbrainz').filter((r) => !r.query.includes('query=')).map((r) => r.path), ['/ws/2/recording/rb'])
  assert.ok(svc.of('musicbrainz').every((r) => r.query.endsWith('&fmt=json&limit=10') || !r.query.includes('query=')))
})

test('details: the album tag picks the release; a recording with 25 releases is chosen among the browse (two pages), track and disc from the release lookup', async (t) => {
  const single = song(200, 121, { album: 'Il Singolo' })
  const browsed = song(200, 123, { album: 'Disco Vero' })
  const svc = await fakeServices()
  const rel = (id, title, type, secondary = [], extra = {}) => ({ id, title, status: 'Official', date: '2020-01-01', 'artist-credit': [{ name: 'Gruppo' }], 'release-group': { id: 'g-' + id, 'primary-type': type, 'secondary-types': secondary }, ...extra })
  svc.answers.acoustid = {
    [compressed('singolo')]: { status: 'ok', results: [{ id: 'aa', score: 0.97, recordings: [{ id: 'RS', title: 'Brano', duration: 200, sources: 10, artists: [{ name: 'Gruppo' }] }] }] },
    [compressed('venticinque')]: { status: 'ok', results: [{ id: 'ab', score: 0.97, recordings: [{ id: 'R25', title: 'Brano 25', duration: 200, sources: 10, artists: [{ name: 'Gruppo' }] }] }] }
  }
  svc.answers.mb = {
    'recording/RS': { id: 'RS', title: 'Brano', 'artist-credit': [{ name: 'Gruppo' }], releases: [
      rel('r-album', 'Il Disco', 'Album', [], { media: [{ position: 1, 'track-count': 12, tracks: [{ position: 5, number: '5' }] }] }),
      rel('r-single', 'Il Singolo', 'Single', [], { media: [{ position: 1, 'track-count': 2, tracks: [{ position: 1, number: '1' }] }] })
    ] },
    'recording/R25': { id: 'R25', title: 'Brano 25', 'artist-credit': [{ name: 'Gruppo' }], releases: Array.from({ length: 25 }, (_, i) => rel('c' + i, 'Raccolta ' + i, 'Album', ['Compilation'], { media: [{ position: 1, tracks: [{ position: i + 1 }] }] })) },
    'release?recording=R25&status=official&inc=release-groups+artist-credits&limit=100&fmt=json': { 'release-count': 101, releases: Array.from({ length: 100 }, (_, i) => rel('p' + i, 'Raccolta ' + i, 'Album', ['Compilation'])) },
    'release?recording=R25&status=official&inc=release-groups+artist-credits&limit=100&offset=100&fmt=json': { 'release-count': 101, releases: [rel('zz-vero', 'Disco Vero', 'Album')] },
    'release/zz-vero': { id: 'zz-vero', title: 'Disco Vero', media: [
      { position: 1, tracks: [{ position: 1, recording: { id: 'OTHER' } }] },
      { position: 2, tracks: [{ position: 1, recording: { id: 'OTHER2' } }, { position: 3, recording: { id: 'R25' } }] }
    ] }
  }
  const fp = { prints: printsOf([{ buf: single, seed: 'singolo', duration: 200 }, { buf: browsed, seed: 'venticinque', duration: 200 }]) }
  const { app, upload } = await start(t, { svc, fp })
  cleanup(t).close(svc)
  const ts = await upload('a.wav', single)
  const tb = await upload('b.wav', browsed)
  await app.details.idle()
  let tr = app.library.getTrack(ts.id)
  assert.deepEqual([tr.album, tr.trackNo, tr.discNo, tr.lookup.release], ['Il Singolo', 1, 1, 'r-single'], 'the album tag wins over the album; the tag itself stays')
  tr = app.library.getTrack(tb.id)
  assert.deepEqual([tr.album, tr.title, tr.trackNo, tr.discNo, tr.lookup.release], ['Disco Vero', 'Brano 25', 3, 2, 'zz-vero'])
  assert.deepEqual(svc.of('musicbrainz').map((r) => r.path + r.query).slice(1), [
    '/ws/2/recording/R25' + INC,
    '/ws/2/release?recording=R25&status=official&inc=release-groups+artist-credits&limit=100&fmt=json',
    '/ws/2/release?recording=R25&status=official&inc=release-groups+artist-credits&limit=100&offset=100&fmt=json',
    '/ws/2/release/zz-vero?inc=recordings&fmt=json'
  ])
})

test('details: only missing fields are written: a tag never, an edit never; the switch turned on at runtime fills at once', async (t) => {
  const tagged = song(185.6, 131, { artist: 'Artista Vero' })
  const svc = await fakeServices()
  svc.answers.acoustid = { [compressed('shinu')]: fixture('acoustid-traccia02') }
  svc.answers.mb = { ['recording/' + REC.shinu]: fixture('mb-recording-shinu') }
  svc.answers.caa = { ['release/' + RELEASE.shinu]: jpeg('x') }
  const fp = { prints: printsOf([{ buf: tagged, seed: 'shinu', duration: 185.6 }]) }
  const { app, owner, upload } = await start(t, { svc, fp })
  cleanup(t).close(svc)
  assert.equal((await owner.call('PATCH', '/api/admin/source', { body: { details: false } })).status, 200)
  const tr0 = await upload('traccia07.wav', tagged)
  assert.equal((await owner.call('PATCH', '/api/tracks/' + tr0.id, { body: { title: 'Il mio titolo', album: 'Album Mio', artist: 'Artista Vero' } })).status, 200)
  assert.deepEqual(app.library.getTrack(tr0.id).edited, ['title', 'album'], 'only what changed is an edit')
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(svc.requests.length, 0, 'the switch off: nothing sent')
  assert.equal((await owner.call('PATCH', '/api/admin/source', { body: { details: true } })).status, 200)
  const tr = await settled(app, tr0.id)
  // The album a person named is not that release: nothing of the release either.
  assert.deepEqual([tr.title, tr.artist, tr.album, tr.albumArtist, tr.year, tr.trackNo, tr.discNo], ['Il mio titolo', 'Artista Vero', 'Album Mio', 'Artista Vero', null, null, null])
  assert.deepEqual(tr.lookup.filled, [], 'the title has no tag, but a person wrote it')
  assert.equal(svc.of('caa').length, 0, 'no cover asked for another album')
  assert.deepEqual(tr.tagless, ['title', 'albumArtist', 'album', 'year', 'trackNo', 'discNo', 'cover'], 'tagless says what the file lacks, whatever was filled')
})

test('details: a library from before: looked up on its first start once its tags are read: a junk title is filled, "Mia canzone" is not; a restart repeats nothing; source.json turned on by hand fills without a restart', async (t) => {
  const c = cleanup(t)
  const dir = c.dir(tmpDir())
  const junk = song(185.6, 141)
  const mine = song(215.9, 143)
  const later = song(259.58, 147)
  const fp = { prints: printsOf([{ buf: junk, seed: 'shinu', duration: 185.6 }, { buf: mine, seed: 'aizo', duration: 215.9 }, { buf: later, seed: 'yoru', duration: 259.58 }]) }
  const svc = await fakeServices()
  c.close(svc)
  svc.answers.acoustid = { [compressed('shinu')]: fixture('acoustid-traccia02'), [compressed('aizo')]: fixture('acoustid-traccia03'), [compressed('yoru')]: fixture('acoustid-traccia01') }
  svc.answers.mb = { ['recording/' + REC.shinu]: fixture('mb-recording-shinu'), ['recording/' + REC.aizo]: fixture('mb-recording-aizo') }
  // Uploaded by a source with no lookups, then made a db.json from before.
  let s = await start(t, { svc, fp, dir, opts: { detailsUrls: null } })
  await s.upload('traccia02.wav', junk)
  await s.upload('Mia canzone.wav', mine)
  await s.app.library.exportCompat()
  await s.app.close()
  const profile = s.owner.profile
  const dbFile = path.join(dir, 'db.json')
  const db = JSON.parse(fs.readFileSync(dbFile, 'utf8'))
  for (const tr of db.tracks) for (const k of ['tagless', 'edited', 'lookup', 'editedUnknown']) delete tr[k]
  fs.writeFileSync(dbFile, JSON.stringify(db))

  // The tags are read after the 60 s fill (here 50 ms then 400 ms): each read asks.
  s = await start(t, { svc, fp, dir, profile, opts: { backgroundDelayMs: 400 } })
  const a = await settled(s.app, hash24(junk))
  const b = await settled(s.app, hash24(mine))
  assert.equal(a.editedUnknown, true)
  assert.deepEqual([a.title, a.artist, a.album], ['死ぬのがいいわ', '藤井風', 'HELP EVER HURT NEVER'], 'traccia02 is nobody\'s title')
  assert.deepEqual([b.title, b.artist, b.album], ['Mia canzone', 'King Gnu', 'AIZO'], 'a title someone may have typed stays')
  assert.equal(b.lookup.filled.includes('title'), false)
  const sent = svc.requests.length
  await s.app.close()

  s = await start(t, { svc, fp, dir, profile })
  await new Promise((resolve) => setTimeout(resolve, 400))
  await s.app.details.idle()
  assert.equal(svc.requests.length, sent, 'a restart repeats nothing')

  // Off, an upload, then source.json edited by hand: on.
  assert.equal((await s.owner.call('PATCH', '/api/admin/source', { body: { details: false } })).status, 200)
  const l = await s.upload('traccia09.wav', later)
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(svc.requests.length, sent)
  const src = JSON.parse(fs.readFileSync(path.join(dir, 'source.json'), 'utf8'))
  fs.writeFileSync(path.join(dir, 'source.json'), JSON.stringify({ ...src, details: true }, null, 2))
  const lt = await settled(s.app, l.id)
  assert.equal(lt.lookup.state, 'ambiguous')
})

test('details: a track missing only its year (or disc, track, album artist) sends nothing; a custom cover counts as a cover', async (t) => {
  const svc = await fakeServices()
  const { app, owner, upload } = await start(t, { svc })
  cleanup(t).close(svc)
  const full = await upload('a.mp3', makeMp3({ frames: 200, title: 'Titolo', artist: 'Artista', album: 'Album', cover: fakePng(4) }))
  assert.deepEqual(app.library.getTrack(full.id).tagless, ['albumArtist', 'year', 'trackNo', 'discNo'])
  const noCover = await upload('b.mp3', makeMp3({ frames: 210, title: 'Altro', artist: 'Artista', album: 'Album' }))
  assert.ok(app.library.getTrack(noCover.id).tagless.includes('cover'))
  await app.details.idle()
  assert.ok(app.library.getTrack(noCover.id).lookup, 'no cover: looked up')
  const before = svc.requests.length
  // A custom cover on its album: no longer missing.
  const third = makeMp3({ frames: 220, title: 'Terzo', artist: 'Artista', album: 'Album' })
  const albumId = albumIdOf({ albumArtist: 'Artista', album: 'Album' })
  assert.equal((await owner.call('PUT', '/api/cover-for/album/' + albumId + '?size=large', { body: fakePng(5) })).status, 200)
  const t3 = await upload('c.mp3', third)
  await app.details.idle()
  assert.equal(app.library.getTrack(t3.id).lookup, undefined)
  assert.equal(svc.requests.length, before)
})

test('details: the cover: asked once per release, the release group when the release has none, nothing over 16 MiB', async (t) => {
  const one = song(185.6, 151)
  const two = song(185.7, 153)
  const three = song(215.9, 157)
  const four = song(216, 159)
  const fp = { prints: printsOf([{ buf: one, seed: 's1', duration: 185.6 }, { buf: two, seed: 's2', duration: 185.7 }, { buf: three, seed: 'a1', duration: 215.9 }, { buf: four, seed: 'a2', duration: 216 }]) }
  const svc = await fakeServices()
  svc.answers.acoustid = { [compressed('s1')]: fixture('acoustid-traccia02'), [compressed('s2')]: fixture('acoustid-traccia02'), [compressed('a1')]: fixture('acoustid-traccia03'), [compressed('a2')]: fixture('acoustid-traccia03') }
  svc.answers.mb = { ['recording/' + REC.shinu]: fixture('mb-recording-shinu'), ['recording/' + REC.aizo]: fixture('mb-recording-aizo') }
  const huge = Buffer.alloc(16 * 1024 * 1024 + 1)
  jpeg('huge').copy(huge)
  svc.answers.caa = { ['release/' + RELEASE.shinu]: jpeg('shinu'), ['release/' + RELEASE.aizo]: huge }
  const { app, dir, upload } = await start(t, { svc, fp })
  cleanup(t).close(svc)
  const t1 = await upload('x1.wav', one)
  const t2 = await upload('x2.wav', two)
  const t3 = await upload('x3.wav', three)
  const t4 = await upload('x4.wav', four)
  await app.details.idle()
  const [a, b, c, d] = [t1, t2, t3, t4].map((x) => app.library.getTrack(x.id))
  assert.ok(a.coverId !== null && a.coverId === b.coverId, 'one cover for the release')
  assert.deepEqual([c.coverId, d.coverId], [null, null], 'over 16 MiB: no cover')
  assert.deepEqual(svc.of('caa').map((r) => r.path), ['/release/' + RELEASE.shinu + '/front-500', '/release/' + RELEASE.aizo + '/front-500'], 'each release asked once')
  const cache = JSON.parse(fs.readFileSync(path.join(dir, 'details.json'), 'utf8'))
  assert.equal(cache.schema, 1)
  assert.deepEqual(Object.keys(cache.caa).sort(), [RELEASE.aizo, RELEASE.shinu].sort())
  assert.equal(cache.caa[RELEASE.aizo].coverId, null)
  assert.equal(cache.caa[RELEASE.shinu].coverId, a.coverId)
})

test('details: requests spaced per service as the services see them (AcoustID 334 ms, MusicBrainz and CAA 1 s); the exact User-Agent', { timeout: 60000 }, async (t) => {
  const one = song(185.6, 161)
  const two = song(215.9, 163)
  const fp = { prints: printsOf([{ buf: one, seed: 'shinu', duration: 185.6 }, { buf: two, seed: 'aizo', duration: 215.9 }]) }
  const svc = await fakeServices()
  svc.answers.acoustid = { [compressed('shinu')]: fixture('acoustid-traccia02'), [compressed('aizo')]: fixture('acoustid-traccia03') }
  svc.answers.mb = { ['recording/' + REC.shinu]: fixture('mb-recording-shinu'), ['recording/' + REC.aizo]: fixture('mb-recording-aizo') }
  svc.answers.caa = { ['release/' + RELEASE.shinu]: jpeg('a'), ['release-group/' + GROUP.aizo]: jpeg('b') }
  const { app, upload } = await start(t, { svc, fp, opts: { detailsPace: undefined } })
  cleanup(t).close(svc)
  await upload('p1.wav', one)
  await upload('p2.wav', two)
  await app.details.idle()
  for (const [service, gap] of [['acoustid', 334], ['musicbrainz', 1000], ['caa', 1000]]) {
    const list = svc.of(service)
    assert.ok(list.length >= 2, service)
    for (let i = 1; i < list.length; i++) assert.ok(list[i].at - list[i - 1].at >= gap, service + ': ' + (list[i].at - list[i - 1].at) + ' ms')
  }
  for (const r of svc.requests) assert.equal(r.headers['user-agent'], UA)
})

test('details: a 503 pauses that service 5 s; three in a row fail the track; a failed lookup is tried again after 6 h, then 12 h, 4 tries at most', { timeout: 60000 }, async (t) => {
  const one = song(185.6, 171)
  const two = song(215.9, 173)
  const fp = { prints: printsOf([{ buf: one, seed: 'shinu', duration: 185.6 }, { buf: two, seed: 'aizo', duration: 215.9 }]) }
  const svc = await fakeServices()
  svc.answers.acoustid = { [compressed('shinu')]: fixture('acoustid-traccia02'), [compressed('aizo')]: fixture('acoustid-traccia03') }
  svc.answers.mb = { ['recording/' + REC.shinu]: fixture('mb-recording-shinu') }
  svc.answers.acoustidStatus = [503]
  const { app, upload } = await start(t, { svc, fp })
  cleanup(t).close(svc)
  const t1 = await upload('r1.wav', one)
  await app.details.idle()
  const ac = svc.of('acoustid')
  assert.equal(ac.length, 2)
  assert.ok(ac[1].at - ac[0].at >= 5000, 'paused ' + (ac[1].at - ac[0].at) + ' ms')
  assert.equal(app.library.getTrack(t1.id).lookup.state, 'applied')
  await app.close()

  let clock = Date.parse('2026-11-18T10:00:00Z')
  const svc2 = await fakeServices()
  svc2.answers.acoustid = { [compressed('aizo')]: fixture('acoustid-traccia03') }
  svc2.answers.mbStatus = [503, 503, 503]
  const s = await start(t, { svc: svc2, fp, opts: { detailsBackoff: [20, 40, 80], detailsNow: () => clock } })
  cleanup(t).close(svc2)
  const t2 = await s.upload('r2.wav', two)
  await s.app.details.idle()
  let tr = s.app.library.getTrack(t2.id)
  assert.deepEqual([tr.lookup.state, tr.lookup.tries, svc2.of('musicbrainz').length], ['failed', 1, 3])
  // MusicBrainz down for good now.
  svc2.answers.mb = { ['recording/' + REC.aizo]: 500 }
  const asked = () => svc2.of('acoustid').length
  const step = async (ms) => {
    clock += ms
    s.app.details.fill()
    await s.app.details.idle()
    return s.app.library.getTrack(t2.id).lookup
  }
  let n = asked()
  assert.equal((await step(6 * 3600e3 - 60e3)).tries, 1, 'not before 6 h')
  assert.equal(asked(), n)
  let l = await step(60e3)
  assert.deepEqual([l.state, l.tries, asked()], ['failed', 2, n + 1], 'after 6 h')
  l = await step(12 * 3600e3 - 60e3)
  assert.equal(l.tries, 2, 'not before 12 h more')
  l = await step(60e3)
  assert.equal(l.tries, 3)
  l = await step(24 * 3600e3)
  assert.equal(l.tries, 4)
  n = asked()
  l = await step(1000 * 3600e3)
  assert.deepEqual([l.tries, asked()], [4, n], 'four tries at most')
  assert.equal(body(await request(s.app.ports.admin, 'GET', '/admin/health')).details.failed, 1)
})

test('details: a lookup that fails after the start-up fill is tried again on its own, 4 tries at most', { timeout: 60000 }, async (t) => {
  const one = song(215.9, 175)
  const fp = { prints: printsOf([{ buf: one, seed: 'aizo', duration: 215.9 }]) }
  const svc = await fakeServices()
  svc.answers.acoustid = { [compressed('aizo')]: fixture('acoustid-traccia03') }
  svc.answers.mb = { ['recording/' + REC.aizo]: 500 }
  const { app, upload } = await start(t, { svc, fp, opts: { detailsRetryBaseMs: 100 } })
  cleanup(t).close(svc)
  await new Promise((resolve) => setTimeout(resolve, 200)) // the start-up fill ran, on an empty library
  const tr = await upload('r3.wav', one)
  const l = await waitFor(() => {
    const now = app.library.getTrack(tr.id).lookup
    return now && now.tries === 4 ? now : null
  }, { timeout: 20000, what: 'the fourth try' })
  assert.equal(l.state, 'failed')
  assert.equal(svc.of('acoustid').length, 4)
  await new Promise((resolve) => setTimeout(resolve, 2500))
  assert.equal(svc.of('acoustid').length, 4, 'no fifth try')
})

test('details: the cover archive failing keeps what the databases found; the cover comes on the next try', { timeout: 60000 }, async (t) => {
  const one = song(185.6, 177)
  const fp = { prints: printsOf([{ buf: one, seed: 'shinu', duration: 185.6 }]) }
  const svc = await fakeServices()
  svc.answers.acoustid = { [compressed('shinu')]: fixture('acoustid-traccia02') }
  svc.answers.mb = { ['recording/' + REC.shinu]: fixture('mb-recording-shinu') }
  svc.answers.caa = { ['release/' + RELEASE.shinu]: 500 }
  const { app, upload } = await start(t, { svc, fp, opts: { detailsRetryBaseMs: 100 } })
  cleanup(t).close(svc)
  const t1 = await upload('traccia02.wav', one)
  let tr = await settled(app, t1.id)
  assert.deepEqual([tr.title, tr.artist, tr.album, tr.albumArtist, tr.year, tr.trackNo, tr.discNo, tr.coverId], ['死ぬのがいいわ', '藤井風', 'HELP EVER HURT NEVER', '藤井風', 2020, 8, 1, null])
  assert.deepEqual([tr.lookup.state, tr.lookup.tries, tr.lookup.release], ['failed', 1, RELEASE.shinu])
  assert.equal(tr.lookup.filled.includes('cover'), false)
  const cache = path.join(app.library.dataDir, 'details.json')
  assert.ok(!fs.existsSync(cache) || JSON.parse(fs.readFileSync(cache, 'utf8')).caa[RELEASE.shinu] === undefined, 'no answer cached')
  svc.answers.caa = { ['release/' + RELEASE.shinu]: jpeg('poi') }
  tr = await waitFor(() => {
    const now = app.library.getTrack(t1.id)
    return now.lookup.tries === 2 ? now : null
  }, { timeout: 20000, what: 'the second try' })
  assert.deepEqual([tr.lookup.state, tr.lookup.filled.includes('cover'), tr.album], ['applied', true, 'HELP EVER HURT NEVER'])
  assert.ok(tr.coverId !== null)
})

test('details: while AcoustID refuses the key, what the text search cannot find is tried again, and AcoustID fills it once the key is good', { timeout: 60000 }, async (t) => {
  const one = song(185.6, 179)
  const fp = { prints: printsOf([{ buf: one, seed: 'shinu', duration: 185.6 }]) }
  const svc = await fakeServices()
  svc.answers.acoustidError = 4
  svc.answers.acoustid = { [compressed('shinu')]: fixture('acoustid-traccia02') }
  svc.answers.mb = { ['recording/' + REC.shinu]: fixture('mb-recording-shinu') }
  const { app, upload } = await start(t, { svc, fp, opts: { detailsRetryBaseMs: 100 } })
  cleanup(t).close(svc)
  const t1 = await upload('traccia02.wav', one)
  let tr = await settled(app, t1.id)
  assert.deepEqual([tr.title, tr.lookup.state, tr.lookup.tries], ['traccia02', 'failed', 1], 'not final: AcoustID was not asked')
  assert.equal((await request(app.ports.http, 'PATCH', '/api/admin/source', { body: { acoustidKey: 'ChiaveBuona1' } })).status, 200)
  svc.answers.acoustidError = null
  tr = await waitFor(() => {
    const now = app.library.getTrack(t1.id)
    return now.lookup.state === 'applied' ? now : null
  }, { timeout: 20000, what: 'the lookup with the new key' })
  assert.deepEqual([tr.title, tr.artist, tr.lookup.tries], ['死ぬのがいいわ', '藤井風', 2])
  assert.ok(svc.of('acoustid').pop().body.startsWith('client=ChiaveBuona1&'))
})

test('details: with no answer from the network nothing is written and no try is counted; the queue waits and goes on', { timeout: 60000 }, async (t) => {
  const one = song(185.6, 189)
  const two = song(215.9, 191)
  const three = song(215.9, 193)
  const fp = { prints: printsOf([{ buf: one, seed: 'shinu', duration: 185.6 }, { buf: two, seed: 'aizo', duration: 215.9 }, { buf: three, seed: 'aizo3', duration: 215.9 }]) }
  const svc = await fakeServices()
  svc.answers.acoustid = { [compressed('shinu')]: fixture('acoustid-traccia02'), [compressed('aizo')]: fixture('acoustid-traccia03'), [compressed('aizo3')]: fixture('acoustid-traccia03') }
  svc.answers.mb = { ['recording/' + REC.shinu]: fixture('mb-recording-shinu'), ['recording/' + REC.aizo]: fixture('mb-recording-aizo') }
  svc.answers.drop = ['acoustid', 'musicbrainz', 'caa']
  const { app, upload } = await start(t, { svc, fp, opts: { detailsOfflinePause: [300, 600] } })
  cleanup(t).close(svc)
  const t1 = await upload('n1.wav', one)
  const t2 = await upload('n2.wav', two)
  await app.details.idle()
  assert.ok(svc.of('acoustid').length >= 1)
  assert.deepEqual([app.library.getTrack(t1.id).lookup, app.library.getTrack(t2.id).lookup], [undefined, undefined], 'nothing written')
  assert.equal(app.details.queued, 2, 'both still queued')
  svc.answers.drop = []
  const a = await settled(app, t1.id)
  const b = await settled(app, t2.id)
  assert.deepEqual([a.lookup.state, a.lookup.tries, a.title], ['applied', 1, '死ぬのがいいわ'])
  assert.deepEqual([b.lookup.state, b.lookup.tries, b.title], ['applied', 1, 'AIZO'])
  // An answer, then the connection lost: that is the track's failure.
  svc.answers.drop = ['musicbrainz']
  const t3 = await upload('n3.wav', three)
  const c = await settled(app, t3.id)
  assert.deepEqual([c.lookup.state, c.lookup.tries], ['failed', 1])
})

test('details: AcoustID refusing the key stops it until the key changes (the text search goes on); the key override is sent; only local requests set it', async (t) => {
  const a = song(200, 181)
  const b = song(200, 183)
  const c = song(185.6, 187)
  const fp = { prints: printsOf([{ buf: a, seed: 'k1', duration: 200 }, { buf: b, seed: 'k2', duration: 200 }, { buf: c, seed: 'shinu', duration: 185.6 }]) }
  const svc = await fakeServices()
  svc.answers.acoustidError = 4
  svc.answers.acoustid = { [compressed('shinu')]: fixture('acoustid-traccia02') }
  svc.answers.mb = { ['recording/' + REC.shinu]: fixture('mb-recording-shinu') }
  const { app, owner, upload } = await start(t, { svc, fp })
  cleanup(t).close(svc)
  const ta = await upload('Uno - Primo.wav', a)
  await app.details.idle()
  assert.equal(svc.of('acoustid').length, 1)
  assert.equal(svc.of('musicbrainz').filter((r) => r.query.includes('query=')).length, 1, 'then the text search')
  assert.equal(app.library.getTrack(ta.id).lookup.state, 'failed', 'tried again later: AcoustID was not asked')
  assert.equal(body(await request(app.ports.admin, 'GET', '/admin/health')).details.acoustidKeyValid, false)
  await upload('Due - Secondo.wav', b)
  await app.details.idle()
  assert.equal(svc.of('acoustid').length, 1, 'AcoustID stopped')
  assert.equal(svc.of('musicbrainz').filter((r) => r.query.includes('query=')).length, 2)

  // Only a local request sets the key; then AcoustID is asked again, with it.
  let r = await owner.call('PATCH', '/api/admin/source', { body: { acoustidKey: 'MiaChiave123' } })
  assert.deepEqual([r.status, body(r).code], [403, 'forbidden'])
  for (const bad of ['corta', 'con spazi 123', 42]) {
    r = await request(app.ports.http, 'PATCH', '/api/admin/source', { body: { acoustidKey: bad } })
    assert.deepEqual([r.status, body(r).code], [400, 'bad_request'], String(bad))
  }
  r = await request(app.ports.http, 'PATCH', '/api/admin/source', { body: { acoustidKey: 'MiaChiave123' } })
  assert.equal(r.status, 200)
  assert.equal(JSON.parse(fs.readFileSync(app.source.file, 'utf8')).acoustidKey, 'MiaChiave123')
  svc.answers.acoustidError = null
  const tc = await upload('c.wav', c)
  await app.details.idle()
  const last = svc.of('acoustid').pop()
  assert.ok(last.body.startsWith('client=MiaChiave123&'), last.body)
  assert.equal(app.library.getTrack(tc.id).lookup.state, 'applied')
  assert.equal(body(await request(app.ports.admin, 'GET', '/admin/health')).details.acoustidKeyValid, true)
  r = await request(app.ports.http, 'PATCH', '/api/admin/source', { body: { acoustidKey: null } })
  assert.equal(r.status, 200)
  assert.equal(JSON.parse(fs.readFileSync(app.source.file, 'utf8')).acoustidKey, null, 'back to the built-in key')
})

test('details: the tracks of an archive are looked up once the archive is done, so its cover image counts first', async (t) => {
  const a = song(185.6, 191)
  const b = song(215.9, 193)
  const fp = { prints: printsOf([{ buf: a, seed: 'shinu', duration: 185.6 }, { buf: b, seed: 'aizo', duration: 215.9 }]) }
  const svc = await fakeServices()
  svc.answers.acoustid = { [compressed('shinu')]: fixture('acoustid-traccia02'), [compressed('aizo')]: fixture('acoustid-traccia03') }
  svc.answers.mb = { ['recording/' + REC.shinu]: fixture('mb-recording-shinu'), ['recording/' + REC.aizo]: fixture('mb-recording-aizo') }
  svc.answers.caa = { ['release/' + RELEASE.shinu]: jpeg('shinu'), ['release-group/' + GROUP.aizo]: jpeg('aizo') }
  const { app, owner } = await start(t, { svc, fp })
  cleanup(t).close(svc)
  // The cover comes last in the listing: the tracks are in the library before it is read.
  const zip = makeZip([{ name: 'Album/01 traccia.wav', data: a }, { name: 'Album/02 traccia.wav', data: b }, { name: 'Album/cover.jpg', data: jpeg('archivio') }])
  const r = await owner.call('PUT', '/api/upload/album.zip', { body: zip })
  assert.equal(r.status, 202)
  await app.archives.idle()
  await app.details.idle()
  const st = body(await owner.call('GET', '/api/archives/' + body(r).archive.id))
  assert.equal(st.added, 2)
  for (const id of st.trackIds) {
    const tr = app.library.getTrack(id)
    assert.equal(tr.coverId, st.coverId, 'the archive cover stays')
    assert.equal(tr.tagless.includes('cover'), false)
    assert.equal(tr.lookup.state, 'applied')
    assert.equal(tr.lookup.filled.includes('cover'), false)
  }
  assert.deepEqual(app.library.getTrack(st.trackIds[0]).title, '死ぬのがいいわ')
  assert.equal(svc.of('caa').length, 0, 'no cover asked: the archive had one')
})

// ------------------------------------------------------------ API and CLI

test('API: PATCH /api/admin/source takes name and details from the owner; a member 403, a wrong body 400 bad_request; details in library, profile and health; the old ETag gets the new switch', async (t) => {
  const { app, owner } = await start(t, { opts: { detailsUrls: null } })
  const member = device(app, { profile: makeProfile(), name: 'Sara' })
  let r = await member.call('PATCH', '/api/admin/source', { body: { details: false } })
  assert.deepEqual([r.status, body(r).code], [403, 'forbidden'])
  for (const bad of [{}, { details: 'no' }, { details: 0 }, { details: null }, { other: true }]) {
    r = await owner.call('PATCH', '/api/admin/source', { body: bad })
    assert.deepEqual([r.status, body(r)], [400, { error: 'Richiesta non valida', code: 'bad_request' }], JSON.stringify(bad))
  }
  r = await member.call('GET', '/api/library')
  const tag = r.headers.etag
  assert.equal(body(r).source.details, true)
  r = await owner.call('PATCH', '/api/admin/source', { body: { details: false } })
  assert.deepEqual([r.status, body(r)], [200, { source: { name: app.name, named: false, details: false } }])
  r = await member.call('GET', '/api/library', { headers: { 'if-none-match': tag } })
  assert.equal(r.status, 200, 'never a 304 with the old switch')
  assert.equal(body(r).source.details, false)
  assert.equal(body(await member.call('GET', '/api/profile')).source.details, false)
  assert.equal(body(await member.call('GET', '/api/health')).details, false)
  assert.equal(body(await request(app.ports.admin, 'GET', '/admin/health')).details.enabled, false)
  r = await owner.call('PATCH', '/api/admin/source', { body: { name: 'Casa', details: true } })
  assert.deepEqual(body(r), { source: { name: 'Casa', named: true, details: true } })
  const stored = JSON.parse(fs.readFileSync(app.source.file, 'utf8'))
  assert.deepEqual([stored.details, stored.acoustidKey], [true, null])
})

test('details: a release of another album gives the track nothing of its own; "Disco - Single" and "Disco (Deluxe)" are "Disco"', async (t) => {
  const live = song(200, 141, { album: 'Dal vivo a Tokyo' })
  const itunes = song(200, 143, { album: 'Il Singolo - Single' })
  const svc = await fakeServices()
  const rel = (id, title, type, position) => ({ id, title, status: 'Official', date: '2020-01-01', 'artist-credit': [{ name: 'Gruppo' }], 'release-group': { id: 'g-' + id, 'primary-type': type, 'secondary-types': [] }, media: [{ position: 1, tracks: [{ position, number: String(position) }] }] })
  const answer = (id) => ({ status: 'ok', results: [{ id: 'a-' + id, score: 0.97, recordings: [{ id, title: 'Brano', duration: 200, sources: 10, artists: [{ name: 'Gruppo' }] }] }] })
  svc.answers.acoustid = { [compressed('dalvivo')]: answer('RL'), [compressed('itunes')]: answer('RI') }
  const recording = (id) => ({ id, title: 'Brano', 'artist-credit': [{ name: 'Gruppo' }], releases: [rel('r-album-' + id, 'Il Disco', 'Album', 5), rel('r-single-' + id, 'Il Singolo', 'Single', 1)] })
  svc.answers.mb = { 'recording/RL': recording('RL'), 'recording/RI': recording('RI') }
  svc.answers.caa = { 'release/r-single-RI': jpeg('s') }
  const fp = { prints: printsOf([{ buf: live, seed: 'dalvivo', duration: 200 }, { buf: itunes, seed: 'itunes', duration: 200 }]) }
  const { app, upload } = await start(t, { svc, fp })
  cleanup(t).close(svc)
  const tl = await upload('traccia05.wav', live)
  const ti = await upload('traccia06.wav', itunes)
  await app.details.idle()
  let tr = app.library.getTrack(tl.id)
  assert.deepEqual([tr.title, tr.artist, tr.album, tr.year, tr.trackNo, tr.discNo, tr.coverId], ['Brano', 'Gruppo', 'Dal vivo a Tokyo', null, null, null, null], 'the song from the recording, nothing from another album')
  assert.equal(tr.lookup.release, null)
  tr = app.library.getTrack(ti.id)
  assert.deepEqual([tr.album, tr.year, tr.trackNo, tr.lookup.release], ['Il Singolo - Single', 2020, 1, 'r-single-RI'], 'the single, by its title without " - Single"')
  assert.ok(tr.coverId)
  assert.deepEqual(svc.of('caa').map((r) => r.path), ['/release/r-single-RI/front-500'])
  assert.ok(releaseFits({ title: 'Disco' }, 'Disco (Deluxe Edition)') && releaseFits({ title: 'Disco' }, 'Disco - Single') && releaseFits({ title: 'Disco' }, null))
  assert.ok(!releaseFits({ title: 'Disco' }, 'Altro') && !releaseFits(null, 'Disco'))
})

test('details: a duplicate brings its real tags over what the network filled, never over an edit; a file-name title is no tag', async (t) => {
  const bare = song(185.6, 151)
  const tagged = song(185.6, 153, { title: 'Shinunoga E-Wa', album: 'HELP EVER HURT NEVER (Deluxe)', artist: 'Qualcuno' })
  const named = song(185.6, 155)
  const svc = await fakeServices()
  svc.answers.acoustid = { [compressed('shinu')]: fixture('acoustid-traccia02') }
  svc.answers.mb = { ['recording/' + REC.shinu]: fixture('mb-recording-shinu') }
  svc.answers.caa = { ['release/' + RELEASE.shinu]: jpeg('x') }
  const fp = { prints: {
    [hash24(bare)]: { duration: 185.6, fingerprint: fingerprintOf('shinu') },
    [hash24(tagged)]: { duration: 185.6, fingerprint: fingerprintOf('shinu', { flip: 1 }) },
    [hash24(named)]: { duration: 185.6, fingerprint: fingerprintOf('shinu', { flip: 2 }) }
  } }
  // One version of one song: the decoder says so.
  const { app, owner, upload } = await start(t, { svc, fp, ff: { pcm: { seed: 'shinu' } } })
  cleanup(t).close(svc)
  const kept = await upload('traccia02.wav', bare)
  let tr = await settled(app, kept.id)
  assert.deepEqual([tr.title, tr.artist, tr.album], ['死ぬのがいいわ', '藤井風', 'HELP EVER HURT NEVER'])
  assert.deepEqual(tr.lookup.filled, ['title', 'artist', 'albumArtist', 'album', 'year', 'trackNo', 'discNo', 'cover'])
  assert.equal((await owner.call('PATCH', '/api/tracks/' + kept.id, { body: { artist: 'Fujii Kaze' } })).status, 200)
  // A file-name title is no tag: it changes nothing.
  assert.equal((await upload('Un altro nome.wav', named)).id, kept.id)
  assert.equal(app.library.getTrack(kept.id).title, '死ぬのがいいわ')
  // Real tags: they take over what the network filled, not the edits (the
  // artist, and the album artist that followed it). Another album: its year,
  // track, disc and cover come again, from the release that album names.
  assert.equal((await upload('copia.wav', tagged)).id, kept.id, 'the same recording, not better: a duplicate')
  await app.details.idle()
  tr = app.library.getTrack(kept.id)
  assert.deepEqual([tr.title, tr.artist, tr.albumArtist, tr.album, tr.year, tr.trackNo, tr.discNo, tr.lookup.release], ['Shinunoga E-Wa', 'Fujii Kaze', 'Fujii Kaze', 'HELP EVER HURT NEVER (Deluxe)', 2020, 8, 1, RELEASE.shinu])
  assert.ok(tr.coverId !== null)
  assert.deepEqual(tr.lookup.filled, ['year', 'trackNo', 'discNo', 'cover'], 'what the tags brought is the file\'s now, the edits are the person\'s')
  assert.ok(!tr.tagless.includes('title') && !tr.tagless.includes('album'))
})

test('details: an album a duplicate brings over the network\'s takes that release\'s album artist, year, track, disc and cover with it, and the track is looked up again with it; a real artist takes the album artist along', async (t) => {
  const files = {
    bare: song(185.6, 221),
    copy: song(185.6, 223, { title: 'Shinunoga E-Wa', artist: 'Fujii Kaze', album: 'HELP EVER HURT NEVER' }),
    lone: song(185.6, 225),
    loneCopy: song(185.6, 227, { artist: 'Fujii Kaze', album: 'HELP EVER HURT NEVER' }),
    plain: song(185.6, 229),
    plainCopy: song(185.6, 231, { artist: 'Fujii Kaze' })
  }
  const print = (seed, flip = 0) => ({ duration: 185.6, fingerprint: fingerprintOf(seed, { flip }) })
  const fp = { prints: {
    [hash24(files.bare)]: print('s1'),
    [hash24(files.copy)]: print('s1', 1),
    [hash24(files.lone)]: print('s2'),
    [hash24(files.loneCopy)]: print('s2', 1),
    [hash24(files.plain)]: print('s3'),
    [hash24(files.plainCopy)]: print('s3', 1)
  } }
  const svc = await fakeServices()
  svc.answers.acoustid = { [compressed('s1')]: fixture('acoustid-traccia02'), [compressed('s2')]: fixture('acoustid-traccia02'), [compressed('s3')]: fixture('acoustid-traccia02') }
  const full = fixture('mb-recording-shinu')
  const onlyCompilation = { ...full, releases: full.releases.filter((r) => r.id === COMPILATION) }
  svc.answers.mb = { ['recording/' + REC.shinu]: onlyCompilation }
  svc.answers.caa = { ['release/' + COMPILATION]: jpeg('raccolta'), ['release/' + RELEASE.shinu]: jpeg('album') }
  // One version of one song: the decoder says so.
  const { app, upload } = await start(t, { svc, fp, ff: { pcm: { seed: 'shinu' } } })
  cleanup(t).close(svc)
  const coverFile = (id) => path.join(app.library.coversDir, id + '.jpg')
  const theAlbum = albumIdOf({ albumArtist: 'Fujii Kaze', album: 'HELP EVER HURT NEVER' })

  // Known only on a compilation: the lookup fills it all from there.
  const kept = await upload('traccia02.wav', files.bare)
  let tr = await settled(app, kept.id)
  assert.deepEqual([tr.album, tr.albumArtist, tr.year, tr.trackNo, tr.discNo, tr.lookup.release], ['Release Round Up Vol.4', 'Various Artists', 2022, 10, 1, COMPILATION])
  const compilationCover = tr.coverId
  assert.ok(compilationCover !== null && fs.existsSync(coverFile(compilationCover)))
  // A copy names the album: what came from the compilation goes, the album's own comes.
  svc.answers.mb = { ['recording/' + REC.shinu]: full }
  assert.equal((await upload('copia.wav', files.copy)).id, kept.id, 'the same recording, not better: a duplicate')
  await app.details.idle()
  tr = app.library.getTrack(kept.id)
  assert.deepEqual([tr.title, tr.artist, tr.album, tr.albumArtist, tr.year, tr.trackNo, tr.discNo, tr.lookup.release], ['Shinunoga E-Wa', 'Fujii Kaze', 'HELP EVER HURT NEVER', 'Fujii Kaze', 2020, 8, 1, RELEASE.shinu])
  assert.equal(albumIdOf(tr), theAlbum, 'in the album of the other files tagged so')
  assert.ok(tr.coverId !== null && tr.coverId !== compilationCover, 'the album\'s cover')
  assert.ok(!fs.existsSync(coverFile(compilationCover)), 'the compilation\'s cover is gone')
  assert.deepEqual([tr.lookup.filled, tr.lookup.stale, tr.tagless], [['year', 'trackNo', 'discNo', 'cover'], undefined, ['albumArtist', 'year', 'trackNo', 'discNo', 'cover']])

  // The same, with no release of that album known: nothing of the compilation stays.
  svc.answers.mb = { ['recording/' + REC.shinu]: onlyCompilation }
  const lone = await upload('traccia03.wav', files.lone)
  tr = await settled(app, lone.id)
  assert.deepEqual([tr.album, tr.year, tr.coverId], ['Release Round Up Vol.4', 2022, compilationCover])
  assert.equal((await upload('copia2.wav', files.loneCopy)).id, lone.id)
  await app.details.idle()
  tr = app.library.getTrack(lone.id)
  assert.deepEqual([tr.album, tr.albumArtist, tr.year, tr.trackNo, tr.discNo, tr.coverId, tr.lookup.state, tr.lookup.release], ['HELP EVER HURT NEVER', 'Fujii Kaze', null, null, null, null, 'applied', null])
  assert.equal(albumIdOf(tr), theAlbum)
  assert.ok(!fs.existsSync(coverFile(compilationCover)))
  assert.equal(app.details.due(tr), false, 'looked up again once, not for ever')

  // A real artist over the network's: the album artist the network filled follows it; the album is the same.
  svc.answers.mb = { ['recording/' + REC.shinu]: full }
  const plain = await upload('traccia04.wav', files.plain)
  tr = await settled(app, plain.id)
  assert.deepEqual([tr.artist, tr.albumArtist, tr.album], ['藤井風', '藤井風', 'HELP EVER HURT NEVER'])
  const sent = svc.requests.length
  assert.equal((await upload('copia3.wav', files.plainCopy)).id, plain.id)
  await app.details.idle()
  tr = app.library.getTrack(plain.id)
  assert.deepEqual([tr.artist, tr.albumArtist, tr.album, tr.year, tr.trackNo, tr.coverId !== null], ['Fujii Kaze', 'Fujii Kaze', 'HELP EVER HURT NEVER', 2020, 8, true])
  assert.deepEqual(tr.lookup.filled, ['title', 'album', 'year', 'trackNo', 'discNo', 'cover'])
  assert.equal(svc.requests.length, sent, 'not looked up again')
})

test('details: an album a duplicate brings while a lookup of the track runs: that answer was for the album it had, the track is looked up again', { timeout: 60000 }, async (t) => {
  const bare = song(185.6, 237)
  const copy = song(185.6, 239, { artist: 'Fujii Kaze', album: 'HELP EVER HURT NEVER' })
  const fp = { prints: {
    [hash24(bare)]: { duration: 185.6, fingerprint: fingerprintOf('shinu') },
    [hash24(copy)]: { duration: 185.6, fingerprint: fingerprintOf('shinu', { flip: 1 }) }
  } }
  const svc = await fakeServices()
  svc.answers.acoustid = { [compressed('shinu')]: fixture('acoustid-traccia02') }
  const full = fixture('mb-recording-shinu')
  svc.answers.mb = { ['recording/' + REC.shinu]: { ...full, releases: full.releases.filter((r) => r.id === COMPILATION) } }
  svc.answers.caa = { ['release/' + COMPILATION]: 500 }
  // One version of one song: the decoder says so.
  const { app, upload } = await start(t, { svc, fp, ff: { pcm: { seed: 'shinu' } }, opts: { detailsRetryBaseMs: 300 } })
  cleanup(t).close(svc)
  const kept = await upload('traccia02.wav', bare)
  let tr = await settled(app, kept.id)
  assert.deepEqual([tr.album, tr.year, tr.lookup.state], ['Release Round Up Vol.4', 2022, 'failed'], 'the cover archive failed: tried again')
  // The second try chose the compilation again and waits for its cover.
  let open
  svc.answers.hold = { caa: new Promise((resolve) => { open = resolve }) }
  svc.answers.caa = { ['release/' + COMPILATION]: jpeg('raccolta'), ['release/' + RELEASE.shinu]: jpeg('album') }
  await waitFor(() => svc.of('caa').length === 2, { what: 'the second cover request' })
  svc.answers.mb = { ['recording/' + REC.shinu]: full }
  assert.equal((await upload('copia.wav', copy)).id, kept.id, 'the same recording, not better: a duplicate')
  open()
  await app.details.idle()
  tr = app.library.getTrack(kept.id)
  assert.deepEqual([tr.album, tr.albumArtist, tr.year, tr.trackNo, tr.discNo, tr.lookup.state, tr.lookup.release, tr.lookup.tries], ['HELP EVER HURT NEVER', 'Fujii Kaze', 2020, 8, 1, 'applied', RELEASE.shinu, 1])
  assert.deepEqual(svc.of('caa').map((r) => r.path), ['/release/' + COMPILATION + '/front-500', '/release/' + COMPILATION + '/front-500', '/release/' + RELEASE.shinu + '/front-500'])
  assert.deepEqual(fs.readdirSync(app.library.coversDir).filter((name) => !name.startsWith(tr.coverId)), [], 'the compilation\'s cover is not kept')
})

// A library and its lookups, with no fingerprints (the text search finds the song).
async function lookups (t, svc) {
  const c = cleanup(t)
  const dir = c.dir(tmpDir())
  const lib = c.close(new Library({ dataDir: dir, debounceMs: 10 }))
  await lib.open()
  const run = (retryBaseMs = 200) => {
    const details = c.close(new Details({
      library: lib, source: { data: {} }, fingerprints: { available: false, runner: null, read: () => null }, dataDir: dir,
      urls: svc.urls, userAgent: UA, fillDelayMs: 10, pace: FAST, retryBaseMs, pollMs: 100000
    }))
    details.start()
    return details
  }
  const details = run()
  svc.answers.mbSearch = () => ({ recordings: [{ id: REC.shinu, score: 100, title: 'Shinunoga E-Wa', length: 185600, 'artist-credit': [{ name: 'Fujii Kaze' }] }] })
  // A track whose album and release details came from a compilation.
  const id = 'a'.repeat(24)
  const coverId = saveCoverBytes(jpeg('raccolta'), lib.coversDir)
  const release = ['albumArtist', 'album', 'year', 'trackNo', 'discNo', 'cover']
  lib.addTrack({
    id, title: 'Shinunoga E-Wa', artist: 'Fujii Kaze', albumArtist: 'Various Artists', album: 'Release Round Up Vol.4', year: 2022, trackNo: 10, discNo: 1,
    duration: 185.6, format: 'wav', fpState: 'none', coverId, tagless: release, edited: [],
    lookup: { v: 1, state: 'applied', at: 1, tries: 1, fileHash: id, release: COMPILATION, filled: release }
  })
  // Another file of it: its album tag, its own picture or none, no year or track.
  const copy = (picture) => ({
    title: 'Shinunoga E-Wa', artist: 'Fujii Kaze', albumArtist: 'Fujii Kaze', album: 'HELP EVER HURT NEVER', year: null, trackNo: null, discNo: null, coverId: picture,
    tagless: ['albumArtist', 'year', 'trackNo', 'discNo', ...(picture ? [] : ['cover'])]
  })
  return { lib, details, id, copy, run }
}

test('details: a lookup after an album change that fails goes on in its time for the year and the track alone, after a restart too, and they come', { timeout: 60000 }, async (t) => {
  const svc = await fakeServices()
  cleanup(t).close(svc)
  svc.answers.mb = { ['recording/' + REC.shinu]: 500 }
  const { lib, details, id, copy, run } = await lookups(t, svc)
  const attempt = (n) => waitFor(() => {
    const now = lib.getTrack(id)
    return now.lookup.stale === undefined && now.lookup.tries === n ? now : null
  }, { what: 'try ' + n })
  // The copy brings its own cover: only the year, the track and the disc are missing.
  const own = saveCoverBytes(jpeg('copia'), lib.coversDir)
  lib.fillEmpty(id, copy(own))
  let tr = await attempt(1)
  assert.deepEqual([tr.lookup.state, tr.year, tr.trackNo, tr.coverId], ['failed', null, null, own])
  tr = await attempt(2)
  assert.deepEqual([tr.lookup.state, tr.year, tr.trackNo], ['failed', null, null])
  // A restart: the next try (due 2 s after the last here) is planned again.
  details.close()
  svc.answers.mb = { ['recording/' + REC.shinu]: fixture('mb-recording-shinu') }
  const again = run(1000)
  tr = await attempt(3)
  assert.deepEqual([tr.album, tr.year, tr.trackNo, tr.discNo, tr.coverId, tr.lookup.state, tr.lookup.release], ['HELP EVER HURT NEVER', 2020, 8, 1, own, 'applied', RELEASE.shinu])
  assert.equal(svc.of('caa').length, 0, 'it has its cover')
  assert.equal(again.due(tr), false)
})

test('details: another field written while a lookup after an album change runs (a quality job) does not repeat the lookup', { timeout: 60000 }, async (t) => {
  const svc = await fakeServices()
  cleanup(t).close(svc)
  svc.answers.mb = { ['recording/' + REC.shinu]: fixture('mb-recording-shinu') }
  svc.answers.caa = { ['release/' + RELEASE.shinu]: jpeg('album') }
  let open
  svc.answers.hold = { caa: new Promise((resolve) => { open = resolve }) }
  const { lib, details, id, copy } = await lookups(t, svc)
  // No picture: the cover is missing too.
  lib.fillEmpty(id, copy(null))
  await waitFor(() => svc.of('caa').length === 1, { what: 'the cover request' })
  lib.setTrack({ ...lib.getTrack(id), qualityV: 1 })
  open()
  const tr = await waitFor(() => {
    const now = lib.getTrack(id)
    return now.lookup.stale === undefined ? now : null
  }, { what: 'the lookup with the new album' })
  await details.idle()
  assert.deepEqual([tr.album, tr.year, tr.trackNo, tr.qualityV, tr.lookup.state, tr.lookup.release], ['HELP EVER HURT NEVER', 2020, 8, 1, 'applied', RELEASE.shinu])
  assert.ok(tr.coverId !== null && fs.existsSync(path.join(lib.coversDir, tr.coverId + '.jpg')))
  assert.deepEqual([svc.of('musicbrainz').length, svc.of('caa').length], [2, 1], 'one search, one recording, one cover')
})

test('library: another file of a track: an album over the network\'s empties its release\'s details and asks for a lookup, an edit stays; an artist takes the album artist along; a cover over the network\'s drops it from covers/; a better file the same', async (t) => {
  const c = cleanup(t)
  const dir = c.dir(tmpDir())
  const lib = c.close(new Library({ dataDir: dir, debounceMs: 10 }))
  await lib.open()
  const details = new Details({ library: lib, source: { data: {} }, fingerprints: {}, dataDir: dir, urls: null, userAgent: UA })
  const asked = []
  lib.onStaleLookup = (id) => asked.push(id)
  const all = ['title', 'artist', 'albumArtist', 'album', 'year', 'trackNo', 'discNo', 'cover']
  const cover = (seed) => {
    const id = saveCoverBytes(jpeg(seed), lib.coversDir)
    fs.writeFileSync(lib.sizedCoverPath(id, 'small'), 'x')
    return id
  }
  const kept = (id) => fs.existsSync(path.join(lib.coversDir, id + '.jpg')) || fs.existsSync(lib.sizedCoverPath(id, 'small'))
  // Everything from the network, from a compilation.
  const add = (id, more = {}) => lib.addTrack({
    id, title: '死ぬのがいいわ', artist: '藤井風', albumArtist: 'Various Artists', album: 'Release Round Up Vol.4', year: 2022, trackNo: 10, discNo: 1,
    format: 'wav', coverId: null, tagless: all, edited: [], lookup: { v: 1, state: 'applied', at: 1, tries: 1, fileHash: id, release: COMPILATION, filled: all }, ...more
  })
  // Another file: a title from its name, `tags` as music-metadata gave them.
  const file = (tags, coverId = null) => ({
    title: 'copia', artist: tags.artist || 'Artista sconosciuto', album: tags.album || UNKNOWN_ALBUM, albumArtist: tags.artist || 'Artista sconosciuto',
    year: null, trackNo: null, discNo: null, coverId, tagless: all.filter((f) => !(f in tags) && !(f === 'cover' && coverId))
  })

  const a = 'a'.repeat(24)
  const c1 = cover('c1')
  add(a, { coverId: c1 })
  lib.fillEmpty(a, file({ artist: 'Fujii Kaze', album: 'HELP EVER HURT NEVER' }))
  let tr = lib.getTrack(a)
  assert.deepEqual([tr.title, tr.artist, tr.album, tr.albumArtist, tr.year, tr.trackNo, tr.discNo, tr.coverId], ['死ぬのがいいわ', 'Fujii Kaze', 'HELP EVER HURT NEVER', 'Fujii Kaze', null, null, null, null])
  assert.deepEqual([tr.tagless, tr.lookup.filled, tr.lookup.stale], [['title', 'albumArtist', 'year', 'trackNo', 'discNo', 'cover'], ['title'], true])
  assert.ok(!kept(c1), 'the compilation\'s cover is gone')
  assert.deepEqual(asked, [a])
  assert.equal(details.due(tr), true)
  assert.equal(normalizeTrack(JSON.parse(JSON.stringify(tr))).lookup.stale, true, 'kept in db.json')

  // An edited album artist stays; the file's own cover takes the place of the network's.
  const b = 'b'.repeat(24)
  const c2 = cover('c2')
  const c3 = cover('c3')
  add(b, { coverId: c2, albumArtist: 'Mio', edited: ['albumArtist'] })
  lib.fillEmpty(b, file({ artist: 'Fujii Kaze', album: 'HELP EVER HURT NEVER' }, c3))
  tr = lib.getTrack(b)
  assert.deepEqual([tr.albumArtist, tr.year, tr.trackNo, tr.coverId, tr.lookup.stale], ['Mio', null, null, c3, true])
  assert.ok(!kept(c2) && kept(c3))
  assert.equal(details.due(tr), true, 'its title, year and track are missing')

  // A cover alone over the network's (the album is the file's own): the network's goes, nothing else changes.
  const d = 'd'.repeat(24)
  const c4 = cover('c4')
  const c5 = cover('c5')
  add(d, { coverId: c4, album: 'Album Mio', tagless: ['title', 'artist', 'albumArtist', 'year', 'trackNo', 'discNo', 'cover'], lookup: { v: 1, state: 'applied', at: 1, tries: 1, fileHash: d, filled: ['cover'] } })
  lib.fillEmpty(d, file({ album: 'Album Mio' }, c5))
  tr = lib.getTrack(d)
  assert.deepEqual([tr.coverId, tr.year, tr.lookup.filled, tr.lookup.stale], [c5, 2022, [], undefined])
  assert.ok(!kept(c4) && kept(c5))

  // A real artist alone: the album artist the network filled follows it.
  const e = 'e'.repeat(24)
  add(e, { albumArtist: '藤井風', album: 'HELP EVER HURT NEVER', year: 2020, trackNo: 8 })
  lib.fillEmpty(e, file({ artist: 'Fujii Kaze' }))
  tr = lib.getTrack(e)
  assert.deepEqual([tr.artist, tr.albumArtist, tr.album, tr.year, tr.trackNo, tr.lookup.stale], ['Fujii Kaze', 'Fujii Kaze', 'HELP EVER HURT NEVER', 2020, 8, undefined])
  assert.deepEqual(tr.lookup.filled, ['title', 'album', 'year', 'trackNo', 'discNo', 'cover'])
  assert.deepEqual(asked, [a, b], 'only an album over the network\'s asks')

  // A better file: the same, and the pipeline asks for its lookup.
  const f = 'f'.repeat(24)
  const c6 = cover('c6')
  add(f, { coverId: c6 })
  fs.mkdirSync(path.dirname(lib.trackPath(lib.getTrack(f))), { recursive: true })
  fs.writeFileSync(lib.trackPath(lib.getTrack(f)), 'old')
  const tmp = path.join(lib.tmpDir, 'nuovo')
  fs.writeFileSync(tmp, 'new')
  lib.replaceFile(f, tmp, { format: 'flac', fileHash: '0'.repeat(24), size: 3 }, file({ artist: 'Fujii Kaze', album: 'HELP EVER HURT NEVER' }))
  tr = lib.getTrack(f)
  assert.deepEqual([tr.album, tr.albumArtist, tr.year, tr.trackNo, tr.discNo, tr.coverId, tr.lookup.stale], ['HELP EVER HURT NEVER', 'Fujii Kaze', null, null, null, null, true])
  assert.ok(!kept(c6))
  assert.equal(details.due(tr), true)
  assert.deepEqual(asked, [a, b])
})

test('details: what an earlier lookup filled stays the network\'s on the next tries, a failed one included', { timeout: 60000 }, async (t) => {
  const one = song(185.6, 233)
  const fp = { prints: printsOf([{ buf: one, seed: 'shinu', duration: 185.6 }]) }
  const svc = await fakeServices()
  svc.answers.acoustid = { [compressed('shinu')]: fixture('acoustid-traccia02') }
  svc.answers.mb = { ['recording/' + REC.shinu]: fixture('mb-recording-shinu') }
  svc.answers.caa = { ['release/' + RELEASE.shinu]: 500 }
  const { app, upload } = await start(t, { svc, fp, opts: { detailsRetryBaseMs: 300 } })
  cleanup(t).close(svc)
  const t1 = await upload('traccia02.wav', one)
  const attempt = (n) => waitFor(() => {
    const now = app.library.getTrack(t1.id)
    return now.lookup && now.lookup.tries === n ? now : null
  }, { timeout: 20000, what: 'try ' + n })
  const release = ['title', 'artist', 'albumArtist', 'album', 'year', 'trackNo', 'discNo']
  let tr = await attempt(1)
  assert.deepEqual([tr.lookup.state, tr.lookup.filled], ['failed', release], 'the cover archive failed')
  // No answer from MusicBrainz: nothing found, nothing forgotten.
  svc.answers.mb = { ['recording/' + REC.shinu]: 500 }
  tr = await attempt(2)
  assert.deepEqual([tr.lookup.state, tr.lookup.filled], ['failed', release])
  // Only the title and the cover were still missing: the rest stays the network's.
  svc.answers.mb = { ['recording/' + REC.shinu]: fixture('mb-recording-shinu') }
  svc.answers.caa = { ['release/' + RELEASE.shinu]: jpeg('poi') }
  tr = await attempt(3)
  assert.deepEqual([tr.lookup.state, tr.lookup.filled], ['applied', [...release, 'cover']])
  assert.ok(tr.coverId !== null)
})

test('details: an album tag with the romanized or translated title (a pseudo-release) gets the official release of its group: year, track and cover', async (t) => {
  const yoru = fixture('mb-recording-yoru').releases
  for (const hint of ['Yoru ni Kakeru', 'Racing Into The Night']) {
    const r = chooseRelease(yoru, hint)
    assert.deepEqual([r.id, r.status, releaseFits(r, hint, yoru)], [SINGLE_YORU, 'Official', true], hint)
  }
  assert.equal(chooseRelease(yoru, 'THE BOOK').title, 'THE BOOK')
  assert.equal(releaseFits(chooseRelease(yoru, 'THE BOOK'), 'Yoru ni Kakeru', yoru), false, 'THE BOOK is not the single')
  const file = song(259.58, 235, { artist: 'YOASOBI', album: 'Yoru ni Kakeru' })
  const svc = await fakeServices()
  svc.answers.acoustid = { [compressed('yoru')]: fixture('acoustid-traccia01') }
  svc.answers.mb = { ['recording/' + REC.yoru]: fixture('mb-recording-yoru') }
  svc.answers.caa = { ['release/' + SINGLE_YORU]: jpeg('singolo') }
  const fp = { prints: printsOf([{ buf: file, seed: 'yoru', duration: 259.58 }]) }
  const { app, upload } = await start(t, { svc, fp })
  cleanup(t).close(svc)
  const up = await upload('夜に駆ける.wav', file)
  const tr = await settled(app, up.id)
  assert.deepEqual([tr.title, tr.artist, tr.album, tr.year, tr.trackNo, tr.discNo, tr.lookup.state, tr.lookup.release], ['夜に駆ける', 'YOASOBI', 'Yoru ni Kakeru', 2019, 1, 1, 'applied', SINGLE_YORU])
  assert.ok(tr.coverId !== null)
  assert.deepEqual(tr.lookup.filled, ['title', 'year', 'trackNo', 'discNo', 'cover'])
})

test('details: a recording with 25 releases: an album tag no official release has is looked for among all of them, a pseudo-release included', async (t) => {
  const file = song(200, 241, { album: 'Romaji' })
  const svc = await fakeServices()
  const rel = (id, title, status, group, groupTitle, type, secondary = []) => ({ id, title, status, date: '2020-01-01', 'artist-credit': [{ name: 'Gruppo' }], 'release-group': { id: group, title: groupTitle, 'primary-type': type, 'secondary-types': secondary } })
  const official = [
    ...Array.from({ length: 30 }, (_, i) => rel('p' + i, 'Raccolta ' + i, 'Official', 'g-p' + i, 'Raccolta ' + i, 'Album', ['Compilation'])),
    rel('s-kanji', 'Kanji', 'Official', 'g-kanji', 'Kanji', 'Single')
  ]
  const BROWSE = '&inc=release-groups+artist-credits&limit=100&fmt=json'
  svc.answers.acoustid = { [compressed('pseudo')]: { status: 'ok', results: [{ id: 'ac', score: 0.97, recordings: [{ id: 'R25', title: 'Brano', duration: 200, sources: 10, artists: [{ name: 'Gruppo' }] }] }] } }
  svc.answers.mb = {
    'recording/R25': { id: 'R25', title: 'Brano', 'artist-credit': [{ name: 'Gruppo' }], releases: official.slice(0, 25) },
    ['release?recording=R25&status=official' + BROWSE]: { 'release-count': official.length, releases: official },
    ['release?recording=R25' + BROWSE]: { 'release-count': official.length + 1, releases: [...official, rel('x-romaji', 'Romaji', 'Pseudo-Release', 'g-kanji', 'Kanji', 'Single')] },
    'release/s-kanji': { id: 's-kanji', title: 'Kanji', media: [{ position: 1, tracks: [{ position: 2, recording: { id: 'R25' } }] }] }
  }
  svc.answers.caa = { 'release/s-kanji': jpeg('kanji') }
  const fp = { prints: printsOf([{ buf: file, seed: 'pseudo', duration: 200 }]) }
  const { app, upload } = await start(t, { svc, fp })
  cleanup(t).close(svc)
  const up = await upload('b.wav', file)
  const tr = await settled(app, up.id)
  assert.deepEqual([tr.album, tr.year, tr.trackNo, tr.discNo, tr.lookup.release, tr.coverId !== null], ['Romaji', 2020, 2, 1, 's-kanji', true])
  assert.deepEqual(svc.of('musicbrainz').map((r) => r.path + r.query), [
    '/ws/2/recording/R25' + INC,
    '/ws/2/release?recording=R25&status=official' + BROWSE,
    '/ws/2/release?recording=R25' + BROWSE,
    '/ws/2/release/s-kanji?inc=recordings&fmt=json'
  ])
})

test('a duplicate or a replacement that fills a field from its own tags takes it out of tagless; a file-name title does not count', async (t) => {
  const bare = song(120, 201)
  const tagged = song(120, 203, { title: 'Titolo Vero', artist: 'Artista Vero' })
  const fp = { prints: { [hash24(bare)]: { duration: 120, fingerprint: fingerprintOf('dup') }, [hash24(tagged)]: { duration: 120, fingerprint: fingerprintOf('dup', { flip: 1 }) } } }
  // One version of one song: the decoder says so.
  const { app, upload } = await start(t, { fp, ff: { pcm: { seed: 'dup' } }, opts: { detailsUrls: null } })
  const kept = await upload('senza nome.wav', bare)
  assert.deepEqual(app.library.getTrack(kept.id).tagless, ['title', 'artist', 'albumArtist', 'album', 'year', 'trackNo', 'discNo', 'cover'])
  const r = await upload('copia.wav', tagged)
  assert.equal(r.id, kept.id, 'the same recording, not better: a duplicate')
  const tr = app.library.getTrack(kept.id)
  assert.deepEqual([tr.title, tr.artist], ['senza nome', 'Artista Vero'], 'the title was not empty (a file name); the artist was')
  assert.deepEqual(tr.tagless, ['title', 'albumArtist', 'album', 'year', 'trackNo', 'discNo', 'cover'], 'the artist came from tags')
})

test('GET /api/profile keeps the shape the client core checks, for the owner, a member, a guest and a local request, with source.details', async (t) => {
  const { app, owner } = await start(t, { opts: { detailsUrls: null } })
  const member = device(app, { profile: makeProfile(), name: 'Sara' })
  const guest = device(app, { name: 'Senza profilo' })
  const local = { call: (m, u) => request(app.ports.http, m, u) }
  for (const [who, role] of [[owner, 'owner'], [member, 'member'], [guest, 'guest'], [local, 'owner']]) {
    const r = await who.call('GET', '/api/profile')
    assert.equal(r.status, 200, role)
    const p = body(r)
    assert.equal(p.role, role)
    assert.ok(p.profileId === null || /^[0-9a-f]{32}$/.test(p.profileId))
    assert.equal(typeof p.source.name, 'string')
    assert.equal(p.source.details, true)
  }
})

test('CLI: details on|off and acoustid-key, with the server running and stopped; claim and code speak in minutes', async (t) => {
  const { app, dir } = await start(t, { opts: { detailsUrls: null } })
  const opts = { dataDir: dir, port: app.ports.http }
  assert.deepEqual(await runCommand(['details', 'off'], opts), ['Dettagli dalla rete: disattivati'])
  assert.equal(app.source.details, false)
  assert.equal(app.details.enabled, false, 'the running server took it at once')
  assert.deepEqual(await runCommand(['details', 'on'], opts), ['Dettagli dalla rete: attivi'])
  assert.equal(app.details.enabled, true)
  assert.deepEqual(await runCommand(['acoustid-key', 'AbCdEf123'], opts), ['Chiave AcoustID aggiornata'])
  assert.equal(app.source.acoustidKey, 'AbCdEf123')
  assert.equal(app.details.acoustidKey, 'AbCdEf123')
  assert.deepEqual(await runCommand(['acoustid-key', '--default'], opts), ['Chiave AcoustID predefinita'])
  assert.equal(app.details.acoustidKey, ACOUSTID_KEY)
  await assert.rejects(runCommand(['acoustid-key', 'no'], opts), /uso: node server\/index\.mjs acoustid-key/)
  await assert.rejects(runCommand(['details', 'forse'], opts), /uso: node server\/index\.mjs details on\|off/)
  await app.close()

  // Stopped: source.json itself.
  const stopped = { dataDir: dir, port: 1 }
  assert.deepEqual(await runCommand(['details', 'off'], stopped), ['Dettagli dalla rete: disattivati'])
  assert.deepEqual(await runCommand(['acoustid-key', 'ChiaveSpenta9'], stopped), ['Chiave AcoustID aggiornata'])
  const src = JSON.parse(fs.readFileSync(path.join(dir, 'source.json'), 'utf8'))
  assert.deepEqual([src.details, src.acoustidKey], [false, 'ChiaveSpenta9'])

  // Claims: minutes from now, never a clock time (the owner was claimed above: a fresh dir).
  const fresh = cleanup(t).dir(tmpDir())
  assert.deepEqual(await runCommand(['claim'], { dataDir: fresh, port: 1 }), ['Finestra aperta per 30 minuti: il primo profilo che aggiunge la fonte ne diventa il proprietario.'])
  assert.deepEqual(await runCommand(['claim', '1'], { dataDir: fresh, port: 1 }), ['Finestra aperta per 1 minuto: il primo profilo che aggiunge la fonte ne diventa il proprietario.'])
  const code = await runCommand(['code'], { dataDir: fresh, port: 1 })
  assert.equal(code[1], 'Nessun proprietario: chi aggiunge la fonte nei prossimi 30 minuti lo diventa.')
  for (const line of [...code, ...(await runCommand(['claim', '45'], { dataDir: fresh, port: 1 }))]) assert.doesNotMatch(line, /\d\d:\d\d/)
})

test('details: a duplicate inside an archive that changes the album is looked up once the archive is done, so it takes the archive cover like its other tracks', { timeout: 60000 }, async (t) => {
  const bare = song(185.6, 221)
  const copy = song(185.6, 223, { title: 'Shinunoga E-Wa', artist: 'Fujii Kaze', album: 'HELP EVER HURT NEVER' })
  const other = song(215.9, 193)
  const other2 = song(150.2, 197)
  const fp = { prints: {
    [hash24(bare)]: { duration: 185.6, fingerprint: fingerprintOf('s1') },
    [hash24(copy)]: { duration: 185.6, fingerprint: fingerprintOf('s1', { flip: 1 }) },
    [hash24(other)]: { duration: 215.9, fingerprint: fingerprintOf('o1') },
    [hash24(other2)]: { duration: 150.2, fingerprint: fingerprintOf('o2') }
  } }
  const svc = await fakeServices()
  svc.answers.acoustid = { [compressed('s1')]: fixture('acoustid-traccia02') }
  const full = fixture('mb-recording-shinu')
  svc.answers.mb = { ['recording/' + REC.shinu]: { ...full, releases: full.releases.filter((r) => r.id === COMPILATION) } }
  svc.answers.caa = { ['release/' + COMPILATION]: jpeg('raccolta'), ['release/' + RELEASE.shinu]: jpeg('album') }
  // One version of one song: the decoder says so.
  const { app, owner, upload } = await start(t, { svc, fp, ff: { pcm: { seed: 'shinu' } } })
  cleanup(t).close(svc)
  const kept = await upload('traccia02.wav', bare)
  await settled(app, kept.id)
  svc.answers.mb = { ['recording/' + REC.shinu]: full }
  const zip = makeZip([{ name: 'Album/01 copia.wav', data: copy }, { name: 'Album/02 altro.wav', data: other }, { name: 'Album/03 altro.wav', data: other2 }, { name: 'Album/cover.jpg', data: jpeg('archivio') }])
  const r = await owner.call('PUT', '/api/upload/album.zip', { body: zip })
  assert.equal(r.status, 202)
  await app.archives.idle()
  await app.details.idle()
  const st = body(await owner.call('GET', '/api/archives/' + body(r).archive.id))
  const tr = app.library.getTrack(kept.id)
  assert.equal(tr.album, 'HELP EVER HURT NEVER')
  assert.ok(st.coverId)
  assert.equal(tr.coverId, st.coverId, 'the archive cover, like its other tracks')
  assert.equal(svc.of('caa').filter((x) => x.path.includes(RELEASE.shinu)).length, 0, 'no cover asked from the network for it')
})

test('details: a track whose tags have no genre gets its genres from MusicBrainz by text: the recording\'s, else its album\'s, else its artist\'s, each album and artist asked once; a genre tag wins and sends nothing; no fingerprint leaves', { timeout: 60000 }, async (t) => {
  const svc = await fakeServices()
  const queries = []
  svc.answers.mbSearch = (q) => {
    queries.push(q)
    const m = /dur:\[(\d+) TO (\d+)\]/.exec(q)
    const length = m ? (Number(m[1]) + Number(m[2])) / 2 : 0
    const title = /recording:"([^"]+)"/.exec(q)[1]
    const id = { Uno: 'r1', Due: 'r2', Tre: 'r3', Quattro: 'r4' }[title]
    return { recordings: id ? [{ id, score: 100, title, length, 'artist-credit': [{ name: 'Artista' }] }] : [] }
  }
  const credit = [{ name: 'Artista', joinphrase: '', artist: { id: 'a1', name: 'Artista' } }]
  const rel = (rg) => [{ id: 'rel-' + rg, title: 'Album', status: 'Official', 'release-group': { id: rg, title: 'Album', 'primary-type': 'Album' } }]
  svc.answers.mb = {
    'recording/r1': { id: 'r1', title: 'Uno', 'artist-credit': credit, releases: rel('g1'), genres: [{ name: 'pop', count: 1 }, { name: 'j-pop', count: 3 }, { name: 'nessuno', count: 0 }] },
    'recording/r2': { id: 'r2', title: 'Due', 'artist-credit': credit, releases: rel('g1'), genres: [] },
    'recording/r3': { id: 'r3', title: 'Tre', 'artist-credit': credit, releases: rel('g1') },
    'recording/r4': { id: 'r4', title: 'Quattro', 'artist-credit': credit, releases: rel('g2') },
    'release-group/g1': { id: 'g1', genres: [{ name: 'city pop', count: 2 }] },
    'release-group/g2': { id: 'g2', genres: [] },
    'artist/a1': { id: 'a1', genres: [{ name: 'soundtrack', count: 5 }, { name: 'musical', count: 4 }, { name: 'pop', count: 1 }, { name: 'jazz', count: 1 }] },
    artist: { artists: [{ id: 'a9', name: 'Mr. Children', score: 80 }, { id: 'a2', name: 'Mr.Children', 'sort-name': 'Mr.Children', score: 100 }] },
    'artist/a2': { id: 'a2', genres: [{ name: 'j-pop', count: 6 }, { name: 'j-rock', count: 3 }] },
    ['artist?query=' + encodeURIComponent('artist:"SPITZ"') + '&fmt=json&limit=5']: { artists: [{ id: 'g1x', name: 'SPITZ', score: 100 }, { id: 'jp1', name: 'Supittsu', 'sort-name': 'Spitz', score: 100 }] },
    'artist/g1x': { id: 'g1x', genres: [{ name: 'grime', count: 2 }] }
  }
  const { app, upload } = await start(t, { svc, opts: { detailsGenres: true } })
  cleanup(t).close(svc)
  const tcon = (g) => [['TCON', Buffer.concat([Buffer.from([0]), Buffer.from(g, 'latin1')])]]
  const mp3 = (title, n, genre = null) => makeMp3({ frames: 2000, title, artist: 'Artista', album: 'Album', cover: fakePng(n), extraFrames: genre ? tcon(genre) : [] })
  const ids = {}
  for (const [title, n, genre] of [['Uno', 1], ['Due', 2], ['Tre', 3], ['Quattro', 4], ['Cinque', 5, 'Rock']]) ids[title] = (await upload(title + '.mp3', mp3(title, n, genre))).id
  // Two songs of an artist MusicBrainz knows only by name here (their titles romanized); one of a
  // name two artists answer to.
  ids.Otto = (await upload('Otto.mp3', makeMp3({ frames: 2000, title: 'Otto', artist: 'SPITZ', album: 'Disco', cover: fakePng(8) }))).id
  for (const [title, n] of [['Sei', 6], ['Sette', 7]]) ids[title] = (await upload(title + '.mp3', makeMp3({ frames: 2000, title, artist: 'Mr.Children, Ospite', album: 'Disco', cover: fakePng(n) }))).id
  await app.details.idle()
  const shown = (title) => app.library.publicTrack(app.library.getTrack(ids[title])).genres
  const mb = svc.of('musicbrainz').map((r) => r.path)
  assert.deepEqual(shown('Sette'), ['j-pop', 'j-rock'])
  assert.deepEqual(shown('Uno'), ['j-pop', 'pop', 'city pop', 'soundtrack', 'musical'], 'the recording\'s (most voted first, none with no vote), its album\'s, its artist\'s: five at most')
  assert.deepEqual(shown('Due'), ['city pop', 'soundtrack', 'musical', 'jazz'], 'none on the recording: its album\'s and its artist\'s (three at most each)')
  assert.deepEqual(shown('Tre'), ['city pop', 'soundtrack', 'musical', 'jazz'])
  assert.deepEqual(shown('Quattro'), ['soundtrack', 'musical', 'jazz'], 'none on its album either: its artist\'s')
  assert.deepEqual(shown('Sei'), ['j-pop', 'j-rock'], 'a title MusicBrainz does not know: the artist by its name')
  assert.equal(shown('Otto'), undefined, 'a name two artists answer to: no genres rather than another artist\'s')
  assert.equal(mb.filter((p) => p === '/ws/2/artist').length, 2, 'each name asked once')
  assert.deepEqual(shown('Cinque'), ['Rock'], 'the tag')
  assert.equal(app.library.getTrack(ids.Cinque).genreLookup, undefined)
  assert.ok(!queries.some((q) => q.includes('Cinque')), 'a track with a genre tag is never sent')
  assert.equal(mb.filter((p) => p.startsWith('/ws/2/release-group/g1')).length, 1, 'an album asked once')
  assert.equal(mb.filter((p) => p.startsWith('/ws/2/artist/a1')).length, 1, 'an artist asked once')
  assert.equal(svc.of('acoustid').length, 0, 'no fingerprint for the genres')
  // Nothing else of a track changes, and once answered it is not asked again.
  assert.equal(app.library.getTrack(ids.Uno).lookup, undefined)
  const before = svc.requests.length
  app.details.fill()
  await app.details.idle()
  assert.equal(svc.requests.length, before)
})
