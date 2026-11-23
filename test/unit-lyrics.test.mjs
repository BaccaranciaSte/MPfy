// Lyrics on a source: the LRC parser, the lyrics of a file's tags (ID3 SYLT and
// USLT, a FLAC's LYRICS, an M4A's lyr), an .lrc beside its audio (ZIP, 7z, a PUT
// with ?beside=1), a PUT and a DELETE and who may make them, the flag in
// /api/library and its version, the first-start job on the tracks from before,
// the index journal, and LRCLIB against a local fake server (the query, the
// User-Agent, the answers, the waits, the retries, the switch, a fill of 1,000
// tracks). Every lyric line in here is invented.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { parseFile } from 'music-metadata'
import { createMPfy, SERVER_VERSION } from '../server/app.mjs'
import { parseLrc, parsePlain, parseLyricsText, isLrcText, hasTimeTag, lyricsFromTags, LyricsError, MAX_LINES, MAX_LINE, MAX_LYRICS_BYTES } from '../server/lrc.mjs'
import { Lyrics, keyOf, queryOf, retryAfterMs, MISS_RETRY_MS, PACE_MS, PUBLISH_MS, MAX_TRIES, RETRY_BASE_MS, BACKOFF, FILL_DELAY_MS, MAX_RETRY_AFTER_MS } from '../server/lyrics.mjs'
import { Journal } from '../server/journal.mjs'
import { UNKNOWN_ALBUM } from '../server/media.mjs'
import { tmpDir, cleanup, request, json, makeProfile, makeCard, device, testWhoIs, makeMp3, makeZip, fakeTool, waitFor, shardPath } from './helpers.mjs'
import { usltFrame, syltFrame, makeFlac, makeM4a } from './lyrics-fixtures.mjs'
import { fakeLrclib, found } from './fake-lrclib.mjs'

const body = (r) => json(r)
const DAY = 24 * 3600 * 1000
const UA = 'MPfy/' + SERVER_VERSION
const SEVEN = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4])

// Invented lines only.
const LINES = ['Lascio il molo al buio', 'Il vento sa il mio nome', 'Torno quando il mare dorme', 'Una lanterna sul pontile']
const LRC = '[ti:Ultimo traghetto]\n[ar:Lumen Marino]\n[00:01.00]' + LINES[0] + '\n[00:04.50]' + LINES[1] + '\n[00:08.00]' + LINES[2] + '\n[00:12.25]' + LINES[3] + '\n'
const LRC2 = '[00:02.00]Sale sulle dita\n[00:05.00]Le reti stese al sole\n[00:09.00]Domani si riparte\n'
const PLAIN = LINES.join('\n')
const SYNCED = [{ t: 1000, text: LINES[0] }, { t: 4500, text: LINES[1] }, { t: 8000, text: LINES[2] }, { t: 12250, text: LINES[3] }]

async function expectCode (pending, status, code) {
  const r = await pending
  assert.equal(r.status, status, r.body.toString())
  assert.equal(body(r).code, code, r.body.toString())
}

// ----------------------------------------------------------- the parser

test('LRC parser: every time tag form, several on a line, header and unknown tags out, word times removed, empty lines kept, lines without a tag out, stable order', () => {
  const r = parseLrc([
    '[ar:Lumen Marino]', '[ti:Ultimo traghetto]', '[al:Mare]', '[by:prova]', '[length: 03:20]', '[xx:sconosciuto]',
    '[00:05]Cinque',
    '[00:06.5]Sei e mezzo',
    '[00:07.25]Sette e un quarto',
    '[00:08.125]Otto e poco',
    '[00:20.00][00:10.00]Due volte',
    '[00:11.00]<00:11.00>Parole <00:11.40>con <00:11.80>tempi',
    '[00:12.00]',
    'una riga senza tempo',
    '[00:13.00]Prima',
    '[00:13.00]Seconda',
    '[01:02.00]Un minuto'
  ].join('\r\n'))
  assert.deepEqual(r, {
    kind: 'synced',
    lines: [
      { t: 5000, text: 'Cinque' }, { t: 6500, text: 'Sei e mezzo' }, { t: 7250, text: 'Sette e un quarto' }, { t: 8125, text: 'Otto e poco' },
      { t: 10000, text: 'Due volte' }, { t: 11000, text: 'Parole con tempi' }, { t: 12000, text: '' }, { t: 13000, text: 'Prima' },
      { t: 13000, text: 'Seconda' }, { t: 20000, text: 'Due volte' }, { t: 62000, text: 'Un minuto' }
    ]
  })
  // [offset:] moves every time (a positive one shows the lines sooner), wherever it stands.
  assert.deepEqual(parseLrc('[00:02.00]A\n[offset:+500]\n[00:03.00]B').lines, [{ t: 1500, text: 'A' }, { t: 2500, text: 'B' }])
  assert.deepEqual(parseLrc('[offset:-250]\n[00:02.00]A').lines, [{ t: 2250, text: 'A' }])
  assert.deepEqual(parseLrc('[offset: 5000]\n[00:02.00]A').lines, [{ t: 0, text: 'A' }], 'never below 0')
})

test('LRC parser: the limits (64 KB, 2,000 lines, 500 code points cut) and what is no lyrics', () => {
  const line = (i) => '[00:' + String(i % 60).padStart(2, '0') + '.00]Riga ' + i
  assert.equal(parseLrc(Array.from({ length: MAX_LINES }, (_, i) => line(i)).join('\n')).lines.length, MAX_LINES)
  assert.throws(() => parseLrc(Array.from({ length: MAX_LINES + 1 }, (_, i) => line(i)).join('\n')), LyricsError, '2,001 lines')
  assert.throws(() => parseLrc(Array.from({ length: 1001 }, (_, i) => '[00:01.00][00:02.00]Doppia ' + i).join('\n')), LyricsError, '2,002 lines from 1,001 with two times')
  assert.throws(() => parseLrc('[00:01.00]' + 'a'.repeat(MAX_LYRICS_BYTES)), LyricsError, 'over 64 KB')
  const long = parseLrc('[00:01.00]' + 'è'.repeat(600)).lines[0].text
  assert.equal(Array.from(long).length, MAX_LINE, 'a line of 600 code points cut at 500')
  assert.throws(() => parseLrc('[00:01.00]\n[00:02.00]'), LyricsError, 'nothing to show')
  assert.throws(() => parseLrc('nessun tempo qui'), LyricsError)
  assert.throws(() => parsePlain(' \n \n'), LyricsError)
  assert.throws(() => parsePlain('[ar:Lumen Marino]\n[ti:Molo]'), LyricsError, 'header tags only')
  assert.throws(() => parsePlain(Array.from({ length: MAX_LINES + 1 }, (_, i) => 'riga ' + i).join('\n')), LyricsError)
  assert.deepEqual(parsePlain('\n[ar:Lumen Marino]\n  ' + LINES[0] + '  \n\n' + LINES[1] + '\n\n'), { kind: 'plain', text: LINES[0] + '\n\n' + LINES[1] })
  // A text a person sends: synced with a time tag, else plain.
  assert.equal(parseLyricsText(LRC).kind, 'synced')
  assert.deepEqual(parseLyricsText(LRC).lines, SYNCED)
  assert.equal(parseLyricsText(PLAIN).kind, 'plain')
  assert.equal(hasTimeTag('a\n [00:01]b'), true)
  assert.equal(hasTimeTag('[ar:x]\nb'), false)
  // A tag's text is LRC with 3 timed lines and more than half of the full ones.
  assert.equal(isLrcText('[00:01]a\n[00:02]b\n[00:03]c\nd'), true)
  assert.equal(isLrcText('[00:01]a\n[00:02]b\nc'), false, 'two timed lines')
  assert.equal(isLrcText('[00:01]a\n[00:02]b\n[00:03]c\nd\ne\nf'), false, 'half, not more')
  assert.equal(isLrcText('[00:01]a\n\n\n[00:02]b\n\n[00:03]c'), true, 'empty lines do not count')
})

test('tags of a hostile file: the work stays within the limits, never the size of the tag', () => {
  const native = (tags) => ({ native: { 'ID3v2.4': tags }, common: {} })
  // A synced tag of 200,000 entries: read until its 2,001st line, then refused.
  let reads = 0
  const entries = new Proxy(Array.from({ length: 200000 }, (_, i) => ({ timestamp: i, text: 'riga ' + i })), {
    get (target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads++
      return Reflect.get(target, key, receiver)
    }
  })
  assert.equal(lyricsFromTags(native([{ id: 'SYLT', value: { timeStampFormat: 2, syncText: entries } }])), null)
  assert.ok(reads <= MAX_LINES + 1, reads + ' entries read')
  // A line of a megabyte, a text of a megabyte: never split into code points whole.
  const from = Array.from
  let longest = 0
  Array.from = function (x, ...rest) {
    if (typeof x === 'string') longest = Math.max(longest, x.length)
    return from.call(this, x, ...rest)
  }
  let cut, plain
  try {
    cut = lyricsFromTags(native([{ id: 'SYLT', value: { timeStampFormat: 2, syncText: [{ timestamp: 1000, text: 'è'.repeat(1 << 20) }, { timestamp: 2000, text: LINES[1] }] } }]))
    plain = lyricsFromTags(native([{ id: 'USLT', value: { text: (LINES[0] + '\n').repeat(50000) } }]))
  } finally {
    Array.from = from
  }
  assert.ok(longest <= 2 * MAX_LINE, longest + ' units split at once')
  assert.equal(cut.lines[0].text, 'è'.repeat(MAX_LINE), 'the long line cut at 500 code points')
  assert.equal(cut.lines[1].text, LINES[1])
  assert.equal(plain, null, 'a text over 64 KB is no lyrics')
  // The cut never splits a pair: 600 astral code points give 500 whole ones.
  const astral = parseLrc('[00:01.00]' + '\u{1F30A}'.repeat(600)).lines[0].text
  assert.equal(Array.from(astral).length, MAX_LINE)
  assert.equal(astral, '\u{1F30A}'.repeat(MAX_LINE))
})

// -------------------------------------------------------------- the tags

const sylt = (lines = SYNCED, opts) => syltFrame(lines, opts)
const mp3 = (title, extraFrames = [], extra = {}) => makeMp3({ title, artist: 'Lumen Marino', album: 'Ultimo traghetto', extraFrames, ...extra })

test('tags: SYLT in ms, USLT with LRC, USLT plain, synced over plain, SYLT in frames is none, a FLAC with LYRICS (offset and two times kept), an M4A with lyr', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  const cases = [
    ['sylt.mp3', mp3('Sylt', [sylt()]), { kind: 'synced', lines: SYNCED }],
    ['uslt-lrc.mp3', mp3('Uslt Lrc', [usltFrame(LRC)]), { kind: 'synced', lines: SYNCED }],
    ['uslt-plain.mp3', mp3('Uslt Plain', [usltFrame(PLAIN + '\nCittà di sale')]), { kind: 'plain', text: PLAIN + '\nCittà di sale' }],
    ['both.mp3', mp3('Both', [usltFrame(PLAIN), sylt()]), { kind: 'synced', lines: SYNCED }],
    ['frames.mp3', mp3('Frames', [sylt(SYNCED, { format: 1 })]), null],
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
    assert.deepEqual(lyricsFromTags(metadata), want, name)
  }
})

// A source whose owner device uploads; options as createMPfy's.
async function start (t, opts = {}) {
  const c = cleanup(t)
  const dir = opts.dataDir || c.dir(tmpDir())
  const app = c.close(await createMPfy({ dataDir: dir, port: 0, adminPort: 0, p2p: false, debounceMs: 10, ffmpeg: null, fpcalc: null, sevenZip: null, whoIs: testWhoIs, ...opts }))
  await app.songsStarted
  if (app.source.ownerProfileId === null) app.people.openClaim(30)
  const owner = device(app, { profile: opts.ownerProfile || makeProfile() })
  assert.equal(body(await owner.call('GET', '/api/profile')).role, 'owner')
  return { app, dir, owner, port: app.ports.http }
}

async function upload (who, name, bytes) {
  const r = await who.call('PUT', '/api/upload/' + encodeURIComponent(name), { body: bytes })
  assert.equal(r.status, 200, r.body.toString())
  return body(r).track
}

async function lyricsOf (who, id) {
  const r = await who.call('GET', '/api/lyrics/' + id)
  return r.status === 200 ? body(r) : { status: r.status, code: body(r).code }
}

async function libraryTrack (who, id) {
  const lib = body(await who.call('GET', '/api/library'))
  return { version: lib.version, track: lib.tracks.find((x) => x.id === id) }
}

test('tags at upload: the lyrics of an MP3, a FLAC and an M4A, served by GET /api/lyrics with their source, the flag in /api/library', async (t) => {
  const { owner } = await start(t)
  const s = await upload(owner, 'sylt.mp3', mp3('Sylt', [sylt()]))
  const p = await upload(owner, 'plain.mp3', mp3('Plain', [usltFrame(PLAIN)]))
  const f = await upload(owner, 'lyrics.flac', makeFlac({ comments: { TITLE: 'Flac', ARTIST: 'Lumen Marino', LYRICS: LRC } }))
  const m = await upload(owner, 'lyr.m4a', makeM4a({ title: 'M4a', lyrics: PLAIN }))
  const n = await upload(owner, 'none.mp3', mp3('None'))
  assert.equal(s.lyrics, 'synced', 'the upload answer carries the flag')
  assert.equal(n.lyrics, undefined)
  assert.deepEqual(await lyricsOf(owner, s.id), { trackId: s.id, kind: 'synced', lines: SYNCED, from: 'tag' })
  assert.deepEqual(await lyricsOf(owner, p.id), { trackId: p.id, kind: 'plain', text: PLAIN, from: 'tag' })
  assert.deepEqual(await lyricsOf(owner, f.id), { trackId: f.id, kind: 'synced', lines: SYNCED, from: 'tag' })
  assert.deepEqual(await lyricsOf(owner, m.id), { trackId: m.id, kind: 'plain', text: PLAIN, from: 'tag' })
  assert.deepEqual(await lyricsOf(owner, n.id), { status: 404, code: 'no_lyrics' })
  await expectCode(owner.call('GET', '/api/lyrics/' + 'f'.repeat(24)), 404, 'no_lyrics')
  await expectCode(owner.call('GET', '/api/lyrics/nope'), 404, 'no_lyrics')
  const lib = body(await owner.call('GET', '/api/library'))
  const flags = Object.fromEntries(lib.tracks.map((x) => [x.id, x.lyrics]))
  assert.deepEqual(flags, { [s.id]: 'synced', [p.id]: 'plain', [f.id]: 'synced', [m.id]: 'plain', [n.id]: undefined })
  assert.equal(Object.prototype.hasOwnProperty.call(lib.tracks.find((x) => x.id === n.id), 'lyrics'), false, 'absent, not null')
})

// ------------------------------------------------------- .lrc beside

function besideCase () {
  return {
    uno: mp3('Uno', [usltFrame('Solo parole ferme')]),
    due: mp3('Due', [sylt()]),
    tre: mp3('Tre'),
    quattro: mp3('Quattro')
  }
}

function checkBeside (app, ids) {
  const e = (id) => app.lyrics.entryOf(id)
  assert.deepEqual([e(ids.Uno).kind, e(ids.Uno).from], ['synced', 'lrc'], 'plain tags: the .lrc beside it (another case of the name) wins')
  assert.deepEqual([e(ids.Due).kind, e(ids.Due).from], ['synced', 'tag'], 'synced tags: the .lrc beside never replaces them')
  assert.deepEqual([e(ids.Tre).kind, e(ids.Tre).from], [null, null], 'an .lrc in another folder is not beside it')
  assert.deepEqual([e(ids.Quattro).kind, e(ids.Quattro).from], ['synced', 'lrc'], 'an .lrc listed before its audio still counts')
}

test('.lrc beside its audio in a ZIP: same folder, same name in any case, only when the tags gave no synced lyrics', async (t) => {
  const { app, owner } = await start(t)
  const a = besideCase()
  const zip = makeZip([
    { name: 'Disco/01 Uno.mp3', data: a.uno },
    { name: 'Disco/01 uno.LRC', data: Buffer.from(LRC) },
    { name: 'Disco/02 Due.mp3', data: a.due },
    { name: 'Disco/02 Due.lrc', data: Buffer.from(LRC2) },
    { name: 'Altro/03 Tre.lrc', data: Buffer.from(LRC2) },
    { name: 'Disco/03 Tre.mp3', data: a.tre },
    { name: 'Disco/04 Quattro.lrc', data: Buffer.from(LRC2) },
    { name: 'Disco/04 Quattro.mp3', data: a.quattro }
  ])
  const r = await owner.call('PUT', '/api/upload/disco.zip', { body: zip })
  assert.equal(r.status, 202, r.body.toString())
  await app.archives.idle()
  const st = body(await owner.call('GET', '/api/archives/' + body(r).archive.id))
  assert.equal(st.added, 4)
  const ids = Object.fromEntries(st.trackIds.map((id) => [app.library.getTrack(id).title, id]))
  checkBeside(app, ids)
  assert.deepEqual((await lyricsOf(owner, ids.Uno)).lines, SYNCED)
})

test('.lrc beside its audio in a 7z (through a fake 7zz)', async (t) => {
  const work = cleanup(t).dir(tmpDir('mpfy-7z-'))
  const seven = fakeTool(work, '7zz', {})
  const { app, owner } = await start(t, { sevenZip: seven.command })
  const a = besideCase()
  const put = (name, data) => {
    const f = path.join(work, name)
    fs.writeFileSync(f, data)
    return f
  }
  const listed = [
    ['Disco/01 Uno.mp3', a.uno], ['Disco/01 uno.LRC', Buffer.from(LRC)], ['Disco/02 Due.mp3', a.due], ['Disco/02 Due.lrc', Buffer.from(LRC2)],
    ['Altro/03 Tre.lrc', Buffer.from(LRC2)], ['Disco/03 Tre.mp3', a.tre], ['Disco/04 Quattro.lrc', Buffer.from(LRC2)], ['Disco/04 Quattro.mp3', a.quattro]
  ]
  seven.control({
    entries: listed.map(([p, d]) => ({ path: p, size: d.length, packed: d.length })),
    // 7-Zip extracts flat: the second "03 Tre.lrc"-like name would get a suffix; these names are all distinct.
    files: listed.map(([p, d], i) => ({ name: path.basename(p), from: put('f' + i, d) }))
  })
  const r = await owner.call('PUT', '/api/upload/disco.7z', { body: Buffer.concat([SEVEN, Buffer.alloc(100)]) })
  assert.equal(r.status, 202, r.body.toString())
  await app.archives.idle()
  const st = body(await owner.call('GET', '/api/archives/' + body(r).archive.id))
  assert.equal(st.state, 'done')
  const ids = Object.fromEntries(st.trackIds.map((id) => [app.library.getTrack(id).title, id]))
  checkBeside(app, ids)
})

// ------------------------------------------------------- PUT and DELETE

test('PUT and DELETE: ?beside=1 never replaces synced lyrics, a PUT replaces anything, the owner or the track\'s own member only; the flag and the library version move at once', async (t) => {
  const { app, owner, port } = await start(t)
  const giulia = device(app, { profile: makeProfile() })
  assert.equal((await giulia.call('PUT', '/api/profile/card', { body: makeCard(giulia.profile, { name: 'Giulia' }) })).status, 200)
  const s = await upload(owner, 'sylt.mp3', mp3('Sylt', [sylt()]))
  const p = await upload(owner, 'plain.mp3', mp3('Plain', [usltFrame(PLAIN)]))
  const g = await upload(giulia, 'sua.mp3', mp3('Sua'))
  const put = (who, id, text, q = '') => who.call('PUT', '/api/lyrics/' + id + q, { body: Buffer.from(text, 'utf8'), headers: { 'content-type': 'text/plain; charset=utf-8' } })

  // beside=1 on synced tags: nothing changes, the answer is what is there.
  let r = await put(owner, s.id, LRC2, '?beside=1')
  assert.equal(r.status, 200, r.body.toString())
  assert.deepEqual(body(r), { trackId: s.id, kind: 'synced', lines: SYNCED, from: 'tag' })
  // beside=1 on plain tags: kept.
  let before = await libraryTrack(owner, p.id)
  r = await put(owner, p.id, LRC, '?beside=1')
  assert.deepEqual(body(r), { trackId: p.id, kind: 'synced', lines: SYNCED, from: 'lrc' })
  let after = await libraryTrack(owner, p.id)
  assert.ok(after.version > before.version, 'the library version moved at once')
  assert.equal(after.track.lyrics, 'synced')
  // A PUT replaces even synced lyrics; a text with no time tag is plain.
  r = await put(owner, s.id, 'Righe nuove\nsenza tempi')
  assert.deepEqual(body(r), { trackId: s.id, kind: 'plain', text: 'Righe nuove\nsenza tempi', from: 'lrc' })
  assert.equal((await libraryTrack(owner, s.id)).track.lyrics, 'plain')

  // Rights: a member on someone else's track 403, on its own 200; a track not here 404.
  await expectCode(put(giulia, s.id, LRC), 403, 'forbidden')
  await expectCode(giulia.call('DELETE', '/api/lyrics/' + s.id), 403, 'forbidden')
  r = await put(giulia, g.id, LRC)
  assert.equal(r.status, 200, r.body.toString())
  assert.equal(body(r).from, 'lrc')
  await expectCode(put(owner, 'f'.repeat(24), LRC), 404, 'version_gone')
  await expectCode(owner.call('DELETE', '/api/lyrics/' + 'f'.repeat(24)), 404, 'version_gone')
  // Texts that are no lyrics.
  await expectCode(put(owner, s.id, ''), 400, 'bad_lyrics')
  await expectCode(put(owner, s.id, '   \n '), 400, 'bad_lyrics')
  await expectCode(put(owner, s.id, 'x'.repeat(MAX_LYRICS_BYTES + 1)), 400, 'bad_lyrics')
  await expectCode(owner.call('PUT', '/api/lyrics/' + s.id, { body: Buffer.from([0x41, 0xff, 0xfe, 0x42]) }), 400, 'bad_lyrics')
  assert.equal((await lyricsOf(owner, s.id)).kind, 'plain', 'unchanged by the refusals')

  // GET: ETag from the text, 304; a caller without a profile (a local request, an older app of
  // the owner) is refused, as every route of the songs part.
  r = await owner.call('GET', '/api/lyrics/' + p.id)
  const tag = r.headers.etag
  assert.match(tag, /^"y[0-9a-f]{16}"$/)
  assert.equal((await owner.call('GET', '/api/lyrics/' + p.id, { headers: { 'if-none-match': tag } })).status, 304)
  await expectCode(request(port, 'GET', '/api/lyrics/' + p.id), 403, 'no_profile')

  // DELETE: the text goes, 404 after, the flag goes at once, nothing is looked up again.
  before = await libraryTrack(owner, p.id)
  r = await owner.call('DELETE', '/api/lyrics/' + p.id)
  assert.equal(r.status, 200)
  assert.deepEqual(body(r), { ok: true })
  assert.deepEqual(await lyricsOf(owner, p.id), { status: 404, code: 'no_lyrics' })
  after = await libraryTrack(owner, p.id)
  assert.ok(after.version > before.version)
  assert.equal(after.track.lyrics, undefined)
  assert.equal(app.lyrics.entryOf(p.id).lookup.state, 'removed')
  assert.equal(fs.existsSync(app.lyrics.fileOf(p.id)), false)
  // A track that goes takes its lyrics with it.
  assert.equal((await owner.call('DELETE', '/api/tracks/' + s.id)).status, 200)
  assert.equal(app.lyrics.entryOf(s.id), null)
  assert.equal(fs.existsSync(app.lyrics.fileOf(s.id)), false)
})

// --------------------------------------------------- the first start job

test('the first start of a source with tracks from before: a media job reads their lyrics tags in process, a few bytes of each file, nothing decoded', async (t) => {
  const c = cleanup(t)
  const dir = c.dir(tmpDir())
  const ownerProfile = makeProfile()
  // A long MP3 (no Xing header: its length is known only by reading every frame).
  const long = mp3('Lungo', [sylt()], { frames: 4000 })
  let id
  {
    const { app, owner } = await start(t, { dataDir: dir, ownerProfile })
    id = (await upload(owner, 'lungo.mp3', long)).id
    const other = await upload(owner, 'altro.mp3', mp3('Altro', [usltFrame(PLAIN)]))
    assert.equal(other.lyrics, 'plain')
    await app.close()
  }
  // As before the lyrics: no index, no texts.
  fs.rmSync(path.join(dir, 'lyrics'), { recursive: true, force: true })
  const file = shardPath(dir, 'library', id + '.mp3')
  assert.ok(fs.statSync(file).size > 1000000)

  // Count what is read of the file, and every run of the media tools.
  const open = fsp.open
  let read = 0
  t.mock.method(fsp, 'open', async (...args) => {
    const fh = await open.apply(fsp, args)
    if (path.resolve(String(args[0])) === path.resolve(file)) {
      const r = fh.read.bind(fh)
      fh.read = async (...a) => {
        const out = await r(...a)
        read += out.bytesRead
        return out
      }
    }
    return fh
  })
  const runs = []
  const ffmpeg = { probe: async () => ({ ok: true, opus: true }), run: async (args) => { runs.push(args) }, close () {}, commandLine: (a) => a.join(' ') }
  const { app } = await start(t, { dataDir: dir, ownerProfile, ffmpeg, backgroundDelayMs: 600000 })
  await app.jobsStarted
  await app.jobs.idle()
  const e = app.lyrics.entryOf(id)
  assert.deepEqual([e.kind, e.from, e.lookup], ['synced', 'tag', null])
  assert.equal(app.library.getTrack(id).lyrics, undefined, 'never on the track object itself')
  assert.equal(app.lyrics.stats.tagsRead, 2)
  assert.deepEqual(runs, [], 'no tool ran')
  t.diagnostic('the lyrics job read ' + read + ' bytes of a file of ' + fs.statSync(file).size)
  assert.ok(read > 0 && read < 64 * 1024, 'only the head of the file was read: ' + read + ' bytes')
  // The control: an exact duration reads the whole file.
  read = 0
  await parseFile(file, { duration: true, skipCovers: true })
  assert.ok(read > 1000000, 'a decode-length read takes ' + read + ' bytes')
  // The fill's flags show at the end of the job (both of them, one move).
  await waitFor(() => app.library.publicTrack(app.library.getTrack(id)).lyrics === 'synced', { what: 'the flag' })
  // The next start reads nothing again.
  await app.close()
  const again = await start(t, { dataDir: dir, ownerProfile })
  await again.app.jobsStarted
  await again.app.jobs.idle()
  assert.equal(again.app.lyrics.stats.tagsRead, 0)
})

// ------------------------------------------------------------ the journal

test('journal: one line per change, the last wins at replay, a cut last line dropped, a bad line skipped, compaction when dead lines pass the live ones', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  const file = path.join(dir, 'j.ndjson')
  const j = new Journal(file, { minDead: 4 }).load()
  j.set('a', { n: 1 })
  j.set('b', { n: 2 })
  const size = fs.statSync(file).size
  j.set('a', { n: 3 })
  assert.equal(fs.statSync(file).size - size, Buffer.byteLength('["a",{"n":3}]\n'), 'a change is one short append')
  j.delete('b')
  assert.equal(j.delete('zz'), false, 'nothing written for a key not there')
  j.close()
  assert.deepEqual(fs.readFileSync(file, 'utf8').split('\n'), ['{"schema":1}', '["a",{"n":1}]', '["b",{"n":2}]', '["a",{"n":3}]', '["b"]', ''])
  // A cut last line and a bad one.
  fs.appendFileSync(file, 'garbage\n["c",{"n":4}]\n["d",{"n"')
  const k = new Journal(file, { minDead: 100 }).load()
  assert.deepEqual([...k.map], [['a', { n: 3 }], ['c', { n: 4 }]])
  assert.ok(fs.readFileSync(file, 'utf8').endsWith('["c",{"n":4}]\n'), 'cut back to the last whole line')
  k.set('e', { n: 5 })
  k.close()
  assert.deepEqual([...new Journal(file).load().map.keys()], ['a', 'c', 'e'])

  // Compaction: past minDead and more dead than live, the file is written again.
  const big = new Journal(path.join(dir, 'big.ndjson'), { minDead: 10, batchLines: 3 }).load()
  for (let i = 0; i < 20; i++) big.set('k' + i, i)
  for (let i = 0; i < 20; i++) big.set('k' + (i % 5), 100 + i)
  await big.settled()
  assert.equal(big.compactions, 0, 'as many dead lines as live ones: not yet')
  big.set('k0', 'uno di troppo')
  await big.settled()
  assert.equal(big.compactions, 1)
  // Changes made while it runs are kept.
  for (let i = 0; i < 30; i++) big.set('x' + (i % 3), i)
  const during = big.settled()
  big.set('late', 1)
  big.delete('k19')
  await during
  big.close()
  const replay = new Journal(path.join(dir, 'big.ndjson')).load()
  assert.deepEqual(Object.fromEntries(replay.map), Object.fromEntries(big.map))
  assert.equal(replay.map.get('late'), 1)
  assert.equal(replay.map.has('k19'), false)
  assert.ok(replay.lines <= 2 * replay.size + 10, 'the file stays within twice its live lines: ' + replay.lines + ' for ' + replay.size)
})

test('journal: a key changed or deleted after the compaction wrote it keeps its change in the new file', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  const file = path.join(dir, 'walk.ndjson')
  const j = new Journal(file, { minDead: 1, batchLines: 2 }).load()
  for (let i = 0; i < 400; i++) j.set('k' + i, 'v' + i)
  for (let i = 0; i < 401; i++) j.set('k' + (i % 400), 'w' + i)
  const running = j.settled()
  // Its first batches (k0, k1 come first) are on disk: change them now.
  await waitFor(() => {
    try {
      return fs.statSync(file + '.tmp').size > 60
    } catch {
      return false
    }
  }, { interval: 1, what: 'the first batches of the rewrite' })
  const before = j.compactions
  j.set('k0', 'dopo')
  j.delete('k1')
  await running
  assert.equal(j.compactions, before + 1, 'the rewrite finished')
  j.close()
  const replay = new Journal(file).load()
  assert.equal(replay.get('k0'), 'dopo')
  assert.equal(replay.has('k1'), false)
  assert.equal(replay.get('k2'), 'w2')
  assert.equal(replay.size, 399)
})

// ---------------------------------------------------------------- LRCLIB

// A library of fake tracks (no files) for the worker alone.
function fakeLibrary (list) {
  const tracks = new Map()
  for (const t of list) tracks.set(t.id, { album: 'Ultimo traghetto', duration: 180, fileHash: t.id, ...t })
  return {
    tracks,
    version: 1,
    bumps: 0,
    getTrack (id) { return tracks.get(id) || null },
    bump () { this.version++; this.bumps++ },
    derivedChanged () { this.bump() },
    trackPath () { return path.join(tmpDir(), 'none.mp3') }
  }
}

const T = (n) => n.toString(16).padStart(24, '0')
const track = (n, extra = {}) => ({ id: T(n), title: 'Brano ' + n, artist: 'Lumen Marino', ...extra })

// A worker on fake tracks whose tags were read (no lyrics), its LRCLIB a fake.
async function worker (t, { tracks, lrclib, details = true, opts = {}, entries = true }) {
  const dir = cleanup(t).dir(tmpDir())
  const library = fakeLibrary(tracks)
  const source = { data: { details } }
  const ly = new Lyrics({ dataDir: dir, library, source, url: lrclib.url, userAgent: UA, paceMs: 0, fillDelayMs: 0, pollMs: 60000, publishMs: 50, ...opts }).load()
  if (entries) for (const tr of library.tracks.values()) ly.index.set(tr.id, { kind: null, from: null, key: keyOf(tr), lookup: null })
  cleanup(t).close(ly)
  return { ly, library, source, dir }
}

async function lrc (t) {
  const fake = await fakeLrclib()
  t.after(() => fake.close())
  return fake
}

test('LRCLIB through the source: an upload is asked at once (the library waits its 60 s), with only title, artist, album and duration and the plain User-Agent; a new title asks again', async (t) => {
  const fake = await lrc(t)
  fake.answers.set('Molo', found({ synced: LRC, plain: PLAIN }))
  const { app, owner } = await start(t, { lyricsUrl: fake.url, lyricsOptions: { paceMs: 0, publishMs: 50 } })
  const tr = await upload(owner, 'molo.mp3', mp3('Molo'))
  await waitFor(() => app.lyrics.entryOf(tr.id).lookup !== null, { what: 'the lookup' })
  assert.equal(fake.requests.length, 1)
  const q = fake.requests[0]
  assert.equal(q.path, '/api/get')
  assert.deepEqual([...q.query.keys()], ['track_name', 'artist_name', 'album_name', 'duration'], 'nothing else in the URL')
  assert.deepEqual(Object.fromEntries(q.query), { track_name: 'Molo', artist_name: 'Lumen Marino', album_name: 'Ultimo traghetto', duration: String(Math.round(tr.duration)) })
  assert.equal(q.headers['user-agent'], UA)
  for (const h of Object.keys(q.headers)) assert.ok(!/mpfy|profile|cookie|authorization/i.test(h), h)
  assert.ok(!q.raw.includes(app.serverPublicKey) && !q.raw.includes(owner.profile.id) && !q.raw.includes(app.name))
  assert.deepEqual(await lyricsOf(owner, tr.id), { trackId: tr.id, kind: 'synced', lines: SYNCED, from: 'lrclib' })
  await waitFor(async () => (await libraryTrack(owner, tr.id)).track.lyrics === 'synced', { what: 'the flag' })

  // The title changes: its key changes, LRCLIB is asked about the new one; a miss takes the old text away.
  assert.equal((await owner.call('PATCH', '/api/tracks/' + tr.id, { body: { title: 'Molo vecchio' } })).status, 200)
  await waitFor(() => fake.of('Molo vecchio').length === 1 && app.lyrics.entryOf(tr.id).lookup.state === 'none', { what: 'the second lookup' })
  assert.deepEqual(await lyricsOf(owner, tr.id), { status: 404, code: 'no_lyrics' })
  // Tags or a person's lyrics are never asked about.
  const tagged = await upload(owner, 'tag.mp3', mp3('Con testo', [sylt()]))
  const put = await owner.call('PUT', '/api/lyrics/' + tagged.id, { body: Buffer.from(LRC2) })
  assert.equal(put.status, 200)
  await app.lyrics.idle()
  assert.equal(fake.of('Con testo').length, 0)
})

test('LRCLIB: synced over plain, plain alone, instrumental (no card), nothing usable is a miss; album left out when unknown, duration above an hour left out', async (t) => {
  const fake = await lrc(t)
  fake.answers.set('Brano 1', found({ synced: LRC, plain: PLAIN }))
  fake.answers.set('Brano 2', found({ plain: PLAIN }))
  fake.answers.set('Brano 3', found({ instrumental: true }))
  fake.answers.set('Brano 4', found({ synced: '', plain: '' }))
  fake.answers.set('Brano 5', found({ synced: 'nessun tempo', plain: PLAIN }))
  const { ly } = await worker(t, { tracks: [track(1), track(2), track(3), track(4), track(5), track(6, { album: UNKNOWN_ALBUM, duration: 3601.2 })], lrclib: fake })
  await ly.start()
  await ly.idle()
  assert.equal(fake.requests.length, 6)
  const e = (n) => ly.entryOf(T(n))
  assert.deepEqual([e(1).kind, e(1).from, e(1).lookup.state], ['synced', 'lrclib', 'found'])
  assert.deepEqual((await ly.read(T(1))).body.lines, SYNCED)
  assert.deepEqual([e(2).kind, e(2).from], ['plain', 'lrclib'])
  assert.deepEqual([e(3).kind, e(3).from, e(3).lookup.state], ['instrumental', 'lrclib', 'found'])
  assert.equal(ly.flagOf(T(3)), null, 'instrumental shows no lyrics')
  assert.equal(await ly.read(T(3)), null)
  assert.deepEqual([e(4).kind, e(4).lookup.state], [null, 'none'])
  assert.deepEqual([e(5).kind, e(5).from], ['plain', 'lrclib'], 'a synced text that is no LRC: the plain one')
  const last = fake.of('Brano 6')[0].query
  assert.deepEqual([...last.keys()], ['track_name', 'artist_name'], 'no album, no duration')
  assert.deepEqual(Object.fromEntries(new URLSearchParams(queryOf(track(7, { album: 'Ultimo traghetto', duration: 3600.4 })).split('?')[1])), { track_name: 'Brano 7', artist_name: 'Lumen Marino', album_name: 'Ultimo traghetto', duration: '3600' })
  // Not asked: no artist, no title of its own, no duration.
  const { ly: none } = await worker(t, { tracks: [track(8, { artist: 'Artista sconosciuto' }), track(9, { title: T(9) }), track(10, { duration: null })], lrclib: fake })
  await none.start()
  await none.idle()
  assert.equal(fake.requests.length, 6)
})

test('LRCLIB: a miss is asked again after its time (30 days), a new key at once; a found one only on a new key', async (t) => {
  assert.equal(MISS_RETRY_MS, 30 * DAY)
  const fake = await lrc(t)
  const { ly, library } = await worker(t, { tracks: [track(1), track(2)], lrclib: fake, opts: { missRetryMs: 300 } })
  fake.answers.set('Brano 2', found({ plain: PLAIN }))
  await ly.start()
  await ly.idle()
  assert.equal(ly.entryOf(T(1)).lookup.state, 'none')
  const first = fake.of('Brano 1')[0].at
  await waitFor(() => fake.of('Brano 1').length === 2, { what: 'the miss asked again' })
  assert.ok(fake.of('Brano 1')[1].at - first >= 280, 'not before its time')
  assert.equal(fake.of('Brano 2').length, 1, 'a found one stays')
  // A new key: at once.
  library.tracks.get(T(2)).album = 'Altro disco'
  ly.trackChanged(T(2), 'edit')
  await waitFor(() => fake.of('Brano 2').length === 2, { what: 'the new key asked' })
  assert.equal(fake.of('Brano 2')[1].query.get('album_name'), 'Altro disco')
  // "Togli testo": not asked again until the key changes.
  ly.remove(T(2))
  ly.trackChanged(T(2), 'set')
  await ly.idle()
  assert.equal(fake.of('Brano 2').length, 2)
  library.tracks.get(T(2)).duration = 200
  ly.trackChanged(T(2), 'set')
  await waitFor(() => fake.of('Brano 2').length === 3, { what: 'asked after a new key' })
})

test('LRCLIB: 429 and 503 wait Retry-After (seconds or a date) or 5, 10, 20, 40, 60 s, then ask the same track again', async (t) => {
  assert.deepEqual([...BACKOFF], [5000, 10000, 20000, 40000, 60000])
  assert.equal(retryAfterMs('2'), 2000)
  assert.equal(retryAfterMs(new Date(Date.now() + 3000).toUTCString(), Date.now()) > 1000, true)
  assert.equal(retryAfterMs(new Date(Date.now() - 3000).toUTCString()), 0)
  assert.equal(retryAfterMs('99999'), MAX_RETRY_AFTER_MS, 'an hour at most')
  assert.equal(retryAfterMs('soon'), null)
  assert.equal(retryAfterMs(null), null)
  const fake = await lrc(t)
  fake.answers.set('Brano 1', found({ plain: PLAIN }))
  fake.first.push({ status: 429 }, { status: 503 }, { status: 429, headers: { 'retry-after': '1' } })
  const { ly } = await worker(t, { tracks: [track(1), track(2)], lrclib: fake, opts: { backoff: [200, 400] } })
  await ly.start()
  await waitFor(() => ly.entryOf(T(1)).lookup !== null && ly.entryOf(T(2)).lookup !== null, { what: 'both answered', timeout: 15000 })
  const at = fake.requests.map((r) => r.at)
  assert.equal(fake.requests.length, 5)
  assert.deepEqual(fake.requests.slice(0, 4).map((r) => r.query.get('track_name')), ['Brano 1', 'Brano 1', 'Brano 1', 'Brano 1'], 'the same track asked again')
  assert.ok(at[1] - at[0] >= 190, 'no Retry-After: the first wait ' + (at[1] - at[0]))
  assert.ok(at[2] - at[1] >= 390, 'then the second ' + (at[2] - at[1]))
  assert.ok(at[3] - at[2] >= 950, 'Retry-After 1 s: ' + (at[3] - at[2]))
  assert.equal(ly.entryOf(T(1)).kind, 'plain')
})

test('LRCLIB: 1,500 ms at least between two starts, one request at a time', async (t) => {
  assert.equal(PACE_MS, 1500)
  const fake = await lrc(t)
  const { ly } = await worker(t, { tracks: [track(1), track(2), track(3)], lrclib: fake, opts: { paceMs: PACE_MS } })
  await ly.start()
  await waitFor(() => fake.requests.length === 3, { what: 'three requests', timeout: 10000 })
  const at = fake.requests.map((r) => r.at)
  assert.ok(at[1] - at[0] >= 1490 && at[2] - at[1] >= 1490, 'gaps ' + (at[1] - at[0]) + ', ' + (at[2] - at[1]))
})

test('LRCLIB: nothing at all while "details" is off; on, the fill starts at once', async (t) => {
  const fake = await lrc(t)
  const { ly, source } = await worker(t, { tracks: [track(1), track(2)], lrclib: fake, details: false, opts: { fillDelayMs: FILL_DELAY_MS } })
  await ly.start()
  ly.request(T(1))
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(fake.requests.length, 0)
  assert.equal(ly.queued, 0)
  source.data.details = true
  ly.sourceChanged()
  await waitFor(() => fake.requests.length === 2, { what: 'the fill at once (not after 60 s)' })
  // Off again: the rest stops.
  source.data.details = false
  ly.sourceChanged()
  ly.trackChanged(T(1), 'edit')
  assert.equal(ly.queued, 0)
})

test('LRCLIB: another failure is retried four times, the waits doubling; no answer at all writes nothing and waits', async (t) => {
  assert.deepEqual([RETRY_BASE_MS, MAX_TRIES], [6 * 3600 * 1000, 5])
  const fake = await lrc(t)
  fake.answers.set('Brano 1', { status: 500, body: { error: 'boom' } })
  const { ly } = await worker(t, { tracks: [track(1)], lrclib: fake, opts: { retryBaseMs: 100 } })
  await ly.start()
  await waitFor(() => fake.requests.length === 5, { what: 'five tries', timeout: 10000 })
  await new Promise((resolve) => setTimeout(resolve, 2000))
  assert.equal(fake.requests.length, 5, 'no sixth')
  assert.deepEqual([ly.entryOf(T(1)).lookup.state, ly.entryOf(T(1)).lookup.tries], ['failed', 5])
  const gaps = fake.requests.slice(1).map((r, i) => r.at - fake.requests[i].at)
  assert.ok(gaps[0] >= 90 && gaps[1] >= 190 && gaps[2] >= 390 && gaps[3] >= 790, 'doubling: ' + gaps.join(', '))

  // No answer: nothing written, the same track asked again after the pause.
  const fake2 = await lrc(t)
  fake2.answers.set('Brano 2', found({ plain: PLAIN }))
  fake2.first.push('drop')
  const { ly: ly2 } = await worker(t, { tracks: [track(2)], lrclib: fake2, opts: { offlinePause: [300] } })
  await ly2.start()
  await waitFor(() => fake2.requests.length === 1, { what: 'the first try' })
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(ly2.entryOf(T(2)).lookup, null, 'nothing written')
  await waitFor(() => ly2.entryOf(T(2)).kind === 'plain', { what: 'the answer after the pause' })
  assert.ok(fake2.requests[1].at - fake2.requests[0].at >= 280)
})

test('LRCLIB: uploads first, then the library after its wait', async (t) => {
  const fake = await lrc(t)
  const { ly } = await worker(t, { tracks: [track(1), track(2), track(3), track(4)], lrclib: fake, opts: { fillDelayMs: 300 } })
  await ly.start()
  ly.added(T(5), null) // not in the library: nothing
  ly.request(T(4))
  await waitFor(() => fake.requests.length === 1, { what: 'the upload' })
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(fake.requests.length, 1, 'the library waits')
  await waitFor(() => fake.requests.length === 4 && ly.queued === 0, { what: 'the library' })
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.deepEqual(fake.requests.map((r) => r.query.get('track_name')), ['Brano 4', 'Brano 1', 'Brano 2', 'Brano 3'], 'a miss is not asked twice')
})

test('LRCLIB: a fill of 1,000 tracks appends one short line per lookup (never the whole index) and moves the library version once, at its end', async (t) => {
  const fake = await lrc(t)
  const tracks = Array.from({ length: 1000 }, (_, i) => track(i + 1))
  for (let i = 1; i <= 1000; i += 2) fake.answers.set('Brano ' + i, found({ synced: LRC2 }))
  const { ly, library, dir } = await worker(t, { tracks, lrclib: fake, opts: { publishMs: PUBLISH_MS } })
  assert.equal(PUBLISH_MS, 5 * 60 * 1000)
  const index = path.join(dir, 'lyrics', 'index.ndjson')
  const before = fs.statSync(index).size
  await ly.start()
  await waitFor(() => fake.requests.length === 1000 && library.bumps > 0, { what: 'the fill and its move', timeout: 60000 })
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(library.bumps, 1, 'one move, at the end of the fill')
  assert.equal(ly.flagOf(T(1)), 'synced')
  assert.equal(ly.flagOf(T(2)), null)
  assert.equal(ly.index.compactions, 0, 'never written whole')
  const grew = fs.statSync(index).size - before
  t.diagnostic('index: ' + grew + ' bytes appended for 1,000 lookups (' + Math.round(grew / 1000) + ' per lookup), ' + ly.index.lines + ' lines for ' + ly.index.size + ' entries')
  assert.ok(grew / 1000 < 200, 'about one short line per lookup: ' + Math.round(grew / 1000) + ' bytes')
  assert.equal(fs.readdirSync(path.join(dir, 'lyrics')).filter((n) => n.endsWith('.json')).length, 500, 'one text file per found track')
})

test('LRCLIB: during a longer fill the library version moves at most once per publish time, and once more at its end', async (t) => {
  const fake = await lrc(t)
  const tracks = Array.from({ length: 60 }, (_, i) => track(i + 1))
  for (let i = 1; i <= 60; i++) fake.answers.set('Brano ' + i, found({ plain: PLAIN }))
  const { ly, library } = await worker(t, { tracks, lrclib: fake, opts: { paceMs: 20, publishMs: 400 } })
  const started = Date.now()
  await ly.start()
  await waitFor(() => fake.requests.length === 60 && ly.flagOf(T(60)) === 'plain', { what: 'the fill', timeout: 20000 })
  const took = Date.now() - started
  assert.ok(library.bumps >= 2, 'it moved during the fill: ' + library.bumps)
  assert.ok(library.bumps <= Math.floor(took / 400) + 2, library.bumps + ' moves in ' + took + ' ms')
  for (let i = 1; i <= 60; i++) assert.equal(ly.flagOf(T(i)), 'plain')
})

test('start: entries and texts of tracks gone are dropped; a text no entry names goes', async (t) => {
  const fake = await lrc(t)
  const { ly, library, dir } = await worker(t, { tracks: [track(1), track(2)], lrclib: fake, details: false })
  await ly.put(T(1), LRC)
  await ly.put(T(2), PLAIN)
  ly.close()
  library.tracks.delete(T(2))
  fs.writeFileSync(path.join(dir, 'lyrics', T(3) + '.json'), '{"kind":"plain","text":"orfano"}')
  const again = cleanup(t).close(new Lyrics({ dataDir: dir, library, source: { data: { details: false } }, url: null, userAgent: UA }).load())
  await again.start()
  assert.equal(again.entryOf(T(2)), null)
  assert.equal(fs.existsSync(path.join(dir, 'lyrics', T(2) + '.json')), false)
  assert.equal(fs.existsSync(path.join(dir, 'lyrics', T(3) + '.json')), false)
  assert.equal((await again.read(T(1))).body.kind, 'synced')
})

test('start: the texts of a big library are looked at a batch at a time, the event loop free between batches', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  const folder = path.join(dir, 'lyrics')
  fs.mkdirSync(folder, { recursive: true })
  const N = 2500
  for (let i = 1; i <= N; i++) fs.writeFileSync(path.join(folder, T(i) + '.json'), '{"kind":"plain","text":"orfano"}')
  const ly = cleanup(t).close(new Lyrics({ dataDir: dir, library: fakeLibrary([]), source: { data: { details: false } }, url: null, userAgent: UA }).load())
  // A turn of the event loop between two batches sees some of the texts gone, not all.
  const seen = []
  let probing = true
  const probe = () => {
    if (!probing) return
    seen.push(fs.readdirSync(folder).length)
    setImmediate(probe)
  }
  setImmediate(probe)
  await ly.start()
  probing = false
  assert.equal(fs.readdirSync(folder).length, 0)
  assert.ok(seen.some((n) => n > 0 && n < N), 'texts left at each turn: ' + [...new Set(seen)].join(','))
})
