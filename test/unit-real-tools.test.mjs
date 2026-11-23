// The real tools on the real album (skipped unless MPFY_REAL_TOOLS=1; on the
// phone deploy/tool-check.sh runs it):
//   MPFY_FFMPEG, MPFY_FPCALC, MPFY_7Z   the tools
//   MPFY_NEA_DIR                        the album (17 m4a and cover.jpg), read only
//   MPFY_TOOL_FIXTURES                  what deploy/tool-fixtures.mjs made on the PC:
//                                       nea.rar, nea-enc.rar, dict1536.7z (each optional)
//   MPFY_TOOL_WORK                      where to make the rest (default: a temp dir)
//   MPFY_7Z_MEM_BYTES                   the prlimit cap to check (default 536870912)
//   MPFY_MUSICA_PROVA                   the test files (Hey Ray "Kokoro", doppioni/,
//                                       senza-dati/), read only (each check skips without)
//   MPFY_REAL_NET=1                     also ask AcoustID and MusicBrainz for real
// fpcalc: each m4a against itself transcoded to mp3 is the same recording,
// different tracks are different, signatures of a file and of its transcode (or
// of the file with 250 ms of silence in front, at the right raw offset) match;
// the fingerprint compressed in JS is fpcalc's own.
// ffmpeg: the real quality (the cutoff and its class) on an encode ladder of a
// genuine FLAC and on the test files; the null test on a FLAC made from an AAC.
// 7-Zip: real 7z and RAR (and ZIP through yauzl) archives of the album through
// the upload pipeline, encrypted ones refused, a 1536 MiB dictionary refused
// under the prlimit cap, and the memory the legit archives really need.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createMPfy } from '../server/app.mjs'
import { Fingerprints, bestOffset, minPairsOf, classify, signatureOf, popcount32, MATCH } from '../server/fingerprint.mjs'
import { FfmpegRunner } from '../server/ffmpeg.mjs'
import { SevenZip, judgeListing, DEFAULT_MEM_BYTES } from '../server/sevenzip.mjs'
import { hasPrlimit } from '../server/tools.mjs'
import { measureQuality, classKbps, applyQuality, nullTest, compareFiles, Spectrum, spectrumArgs, MAX_PCM_BYTES, QUALITY_TIMEOUT } from '../server/quality.mjs'
import { compressFingerprint, DETAILS_URLS } from '../server/details.mjs'
import { request, json, waitFor, makeProfile, device, testWhoIs, CALIBRATION_VECTORS } from './helpers.mjs'

const env = process.env
const REAL = env.MPFY_REAL_TOOLS === '1'
const SKIP = REAL ? false : 'real tools only: MPFY_REAL_TOOLS=1 (deploy/tool-check.sh)'
const NEA = env.MPFY_NEA_DIR || ''
const FIXTURES = env.MPFY_TOOL_FIXTURES || ''
const CAP = Number(env.MPFY_7Z_MEM_BYTES || DEFAULT_MEM_BYTES)
const MUSICA = env.MPFY_MUSICA_PROVA || ''
const SKIP_MUSICA = SKIP || (MUSICA ? false : 'the test files: MPFY_MUSICA_PROVA')
const SKIP_NET = SKIP_MUSICA || (env.MPFY_REAL_NET === '1' ? false : 'the real services: MPFY_REAL_NET=1')
let work = null

function workDir () {
  if (work === null) {
    work = env.MPFY_TOOL_WORK || fs.mkdtempSync(path.join(os.tmpdir(), 'mpfy-tools-'))
    fs.mkdirSync(work, { recursive: true })
  }
  return work
}

function songs () {
  return fs.readdirSync(NEA).filter((n) => n.endsWith('.m4a')).sort().map((n) => path.join(NEA, n))
}

const ffmpeg = () => new FfmpegRunner({ command: env.MPFY_FFMPEG })

async function fingerprints () {
  const fps = new Fingerprints({ dataDir: workDir(), command: env.MPFY_FPCALC })
  assert.equal(await fps.probe(), true, 'fpcalc -version exits 0')
  return fps
}

// The app's signature comparison: raw item r of A against raw item r + k of B.
function compareSignatures (A, B) {
  const unpack = (s) => {
    const buf = Buffer.from(s, 'base64')
    return Array.from({ length: buf.length / 4 }, (_, i) => buf.readUInt32LE(i * 4))
  }
  const sa = unpack(A.s)
  const sb = unpack(B.s)
  const minPairs = Math.min(32, Math.floor(0.8 * Math.min(sa.length, sb.length)))
  let best = null
  for (let k = -16; k <= 16; k++) {
    let bits = 0
    let n = 0
    for (let j = 0; j < sa.length; j++) {
      const jb = A.b + j + k - B.b
      if (jb < 0 || jb >= sb.length) continue
      bits += popcount32((sa[j] ^ sb[jb]) >>> 0)
      n++
    }
    if (n === 0 || n < minPairs) continue
    const ber = bits / (32 * n)
    if (best === null || ber < best.ber) best = { ber, k, n }
  }
  return best
}

async function transcode (input, output, args) {
  if (fs.existsSync(output)) return output
  await ffmpeg().run(['-nostdin', '-v', 'error', '-i', input, ...args, '-y', output], { lowPriority: false, timeoutMs: 600000 })
  return output
}

test('[tool] fpcalc on the album: each m4a and its mp3 are the same recording; different tracks differ; signatures match, with 250 ms of silence too at the right raw offset', { skip: SKIP, timeout: 30 * 60000 }, async (t) => {
  const fps = await fingerprints()
  const files = songs()
  assert.equal(files.length, 17)
  const originals = []
  for (const [i, file] of files.entries()) {
    const fp = await fps.compute(file)
    assert.ok(fp !== null && fp.items.length > 900, 'fpcalc on ' + path.basename(file))
    originals.push(fp)
    const mp3 = await transcode(file, path.join(workDir(), 'mp3-' + i + '.mp3'), ['-map', '0:a:0', '-vn', '-c:a', 'libmp3lame', '-b:a', '192k'])
    const other = await fps.compute(mp3)
    const best = bestOffset(fp.items, other.items, MATCH.offsets)
    const kind = classify(best.ber, Math.abs(fp.duration - other.duration))
    t.diagnostic(path.basename(file) + ': mp3 BER ' + best.ber.toFixed(4) + ' at ' + best.k + ', durations ' + fp.duration + ' / ' + other.duration)
    assert.equal(kind, 'same', path.basename(file))
    const sig = compareSignatures(signatureOf(fp.items, fp.duration), signatureOf(other.items, other.duration))
    assert.ok(sig.ber <= 0.12, 'signatures of ' + path.basename(file) + ': ' + sig.ber)
  }
  // Tracks 6 and 16 are two versions of one song ("Epilogue", NEA's and the
  // original with Rio): exactly what "maybe" asks about. Every other pair differs.
  let closest = 1
  for (let a = 0; a < originals.length; a++) {
    for (let b = a + 1; b < originals.length; b++) {
      const best = bestOffset(originals[a].items, originals[b].items, MATCH.offsets, minPairsOf(originals[a].items, originals[b].items))
      const kind = classify(best.ber, Math.abs(originals[a].duration - originals[b].duration))
      if (a === 5 && b === 15) {
        t.diagnostic('tracks 6 and 16 (two versions of Epilogue): BER ' + best.ber.toFixed(4) + ', ' + kind)
        assert.equal(kind, 'maybe', 'two versions of one song: asked, never merged by themselves')
        continue
      }
      closest = Math.min(closest, best.ber)
      assert.equal(kind, null, 'tracks ' + (a + 1) + ' and ' + (b + 1) + ' differ')
    }
  }
  t.diagnostic('closest pair of different songs: BER ' + closest.toFixed(4))
  assert.ok(closest > MATCH.maybeBer)

  // 250 ms of silence in front: about two items later.
  for (const i of [0, 4, 9]) {
    const delayed = await transcode(files[i], path.join(workDir(), 'delay-' + i + '.flac'), ['-map', '0:a:0', '-vn', '-af', 'adelay=250:all=1', '-c:a', 'flac'])
    const fp = await fps.compute(delayed)
    const sig = compareSignatures(signatureOf(originals[i].items, originals[i].duration), signatureOf(fp.items, fp.duration))
    t.diagnostic(path.basename(files[i]) + ' + 250 ms: signature BER ' + sig.ber.toFixed(4) + ' at raw offset ' + sig.k)
    assert.ok(sig.ber <= 0.12, 'delayed ' + i + ': ' + sig.ber)
    assert.equal(sig.k, 2, 'A[r] pairs with B[r + 2]: 250 ms / 123.81 ms')
    assert.ok(Math.abs(signatureOf(fp.items, fp.duration).d - originals[i].duration) <= 1.5)
  }
})

// --------------------------------------------------------- real quality

function durationOf (file) {
  const probe = env.MPFY_FFMPEG.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1')
  const out = spawnSync(probe, ['-v', 'error', '-show_entries', 'format=duration:format=bit_rate', '-of', 'json', file]).stdout.toString()
  const f = JSON.parse(out).format || {}
  return { duration: Number(f.duration) || null, bitrate: Number(f.bit_rate) || null }
}

// The band levels of a file, measured as the analysis does.
async function levelsOf (ff, file, duration) {
  const s = new Spectrum()
  await ff.stream(spectrumArgs(file, duration), (chunk) => s.push(chunk), { timeoutMs: QUALITY_TIMEOUT, maxBytes: MAX_PCM_BYTES, quiet: true })
  return s.levels().C
}

const kokoroDir = () => path.join(MUSICA, 'Hey Ray! - Kokoro (10th Anniversary Edition)')
const kokoro = (n) => fs.readdirSync(kokoroDir()).filter((x) => x.includes(' - ' + String(n).padStart(2, '0') + ' ') && x.endsWith('.flac')).map((x) => path.join(kokoroDir(), x))[0]
const AUDIO_RE = /\.(mp3|m4a|flac|opus|ogg)$/i

function audioFiles (dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...audioFiles(p))
    else if (AUDIO_RE.test(e.name)) out.push(p)
  }
  return out.sort()
}

test('[tool] real quality: the encode ladder of a genuine FLAC, the test files and the album give the calibrated cutoffs and classes; the album decoded to FLAC is a known miss', { skip: SKIP_MUSICA, timeout: 30 * 60000 }, async (t) => {
  const ff = ffmpeg()
  const genuine = kokoro(2) // Hey Ray "Kokoro" track 02: full band to 22 kHz
  const a = ['-map', '0:a:0', '-vn']
  const enc = (name, src, args) => transcode(src, path.join(workDir(), 'ladder-' + name), [...a, ...args])
  // [name, file, expected cutoff, expected class (when cut)]
  const cases = []
  const add = async (name, src, args, cutoff, cls = null) => cases.push([name, await enc(name, src, args), cutoff, cls])
  await add('excerpt.flac', genuine, ['-t', '60', '-c:a', 'flac'], null)
  await add('lame320.mp3', genuine, ['-c:a', 'libmp3lame', '-b:a', '320k'], null)
  await add('lameV0.mp3', genuine, ['-c:a', 'libmp3lame', '-q:a', '0'], null)
  await add('aac256.m4a', genuine, ['-c:a', 'aac', '-b:a', '256k'], null)
  for (const k of [96, 128, 160]) await add('opus' + k + '.opus', genuine, ['-c:a', 'libopus', '-b:a', k + 'k'], null)
  for (const q of [5, 7]) await add('vorbis-q' + q + '.ogg', genuine, ['-c:a', 'libvorbis', '-q:a', String(q)], null)
  for (const [k, cut, cls] of [[96, 15500, 112], [128, 17000, 128], [160, 17500, 160], [192, 19000, 192], [224, 19500, 256], [256, 19500, 256]]) {
    await add('lame' + k + '.mp3', genuine, ['-c:a', 'libmp3lame', '-b:a', k + 'k'], cut, cls)
  }
  await add('aac128.m4a', genuine, ['-c:a', 'aac', '-b:a', '128k'], 17500, 160)
  await add('aac192.m4a', genuine, ['-c:a', 'aac', '-b:a', '192k'], 19500, 256)
  await add('vorbis-q3.ogg', genuine, ['-c:a', 'libvorbis', '-q:a', '3'], 18500, 192)
  const byName = Object.fromEntries(cases.map((c) => [c[0], c[1]]))
  await add('lame128-to-320.mp3', byName['lame128.mp3'], ['-c:a', 'libmp3lame', '-b:a', '320k'], 17000, 128)
  await add('aac128-to-mp3-320.mp3', byName['aac128.m4a'], ['-c:a', 'libmp3lame', '-b:a', '320k'], 17500, 160)
  await add('lame192-to-aac256.m4a', byName['lame192.mp3'], ['-c:a', 'aac', '-b:a', '256k'], 19000, 192)
  for (const from of ['lame320.mp3', 'lameV0.mp3', 'aac256.m4a', 'opus160.opus', 'vorbis-q7.ogg']) {
    await add(from.replace(/\.\w+$/, '') + '-to.flac', byName[from], ['-c:a', 'flac'], null)
  }
  // The test files as they are.
  const own = (rel, cut, cls = null) => cases.push([rel, path.join(MUSICA, rel), cut, cls])
  own('senza-dati/traccia01.mp3', 14500, 80) // 夜に駆ける, nominal 320
  own('senza-dati/traccia02.mp3', null) // a real 320
  own('senza-dati/traccia03.mp3', null)
  own('doppioni/Kokoro (mp3 320, dal FLAC).mp3', 19500, 256) // made from the 19.5 kHz-cut track 01
  own('doppioni/Last Scene (mp3 192).mp3', 19000, 192)
  own('doppioni/Last Scene (opus 128).opus', null)
  // The netlabel album: 8 of the 9 lossy-sourced tracks found, 09 is cut above 19.5 kHz, 02 is genuine.
  const album = { 1: [19500, 256], 2: [null], 3: [19000, 192], 4: [16000, 112], 5: [19500, 256], 6: [16000, 112], 7: [16000, 112], 8: [17500, 160], 9: [null], 10: [19000, 192] }
  for (const [n, [cut, cls]] of Object.entries(album)) cases.push(['Kokoro ' + n, kokoro(n), cut, cls || null])
  if (NEA) for (const f of songs()) cases.push(['NEA ' + path.basename(f), f, null, null])

  const misses = []
  for (const [name, file, want, cls] of cases) {
    const { duration, bitrate } = durationOf(file)
    const measured = await measureQuality(ff, file, duration)
    assert.notEqual(measured, null, name + ': conclusive')
    t.diagnostic(name + ': ' + (measured.cutoffHz === null ? 'no cut' : measured.cutoffHz + ' Hz, ~' + classKbps(measured.cutoffHz)))
    assert.equal(measured.cutoffHz, want, name)
    if (cls !== null) assert.equal(classKbps(measured.cutoffHz), cls, name + ' class')
    // The verdict: lossless files by extension, lossy ones against their bitrate.
    const lossless = /\.flac$/i.test(file)
    const v = applyQuality({ lossless, codec: lossless ? 'flac' : 'mp3', bitrate, bitDepth: 16, sampleRate: 44100 }, measured)
    if (lossless) assert.equal(v.fakeLossless, want !== null, name + ' fake lossless')
  }
  // The calibration vectors the unit tests use are what these files measure: every
  // band within 0.5 dB, but the floor of the AAC re-encode (its encoder's noise above
  // the cut) within 6 dB.
  const fileOf = (name) => cases.find((c) => c[0] === name)[1]
  const vectorFiles = {
    lame128: fileOf('lame128.mp3'),
    lame320: fileOf('lame320.mp3'),
    opus128: fileOf('opus128.opus'),
    aacFromMp3: fileOf('lame192-to-aac256.m4a'),
    genuine,
    dithered16k: kokoro(4),
    yoru320: path.join(MUSICA, 'senza-dati/traccia01.mp3'),
    ...(NEA ? { nea06: songs()[5] } : {})
  }
  for (const [name, file] of Object.entries(vectorFiles)) {
    const [cut, want] = CALIBRATION_VECTORS[name]
    const C = await levelsOf(ff, file, durationOf(file).duration)
    const off = C.map((v, j) => Math.abs(v - want[j]))
    t.diagnostic(name + ': at most ' + Math.max(...off).toFixed(2) + ' dB from its vector')
    for (const [j, d] of off.entries()) {
      const room = name === 'aacFromMp3' && 2000 + 500 * j >= cut ? 6 : 0.5
      assert.ok(d <= room, name + ' band ' + j + ': ' + C[j].toFixed(1) + ' against ' + want[j])
    }
  }

  // What the class does to a lossy file: only an inflated one is downgraded.
  const verdict = (name, kbps) => applyQuality({ lossless: false, codec: 'mp3', bitrate: kbps * 1000 }, { cutoffHz: cases.find((c) => c[0] === name)[2] })
  assert.equal(verdict('lame128.mp3', 128).equivKbps, null, 'an honest 128')
  assert.equal(verdict('lame128-to-320.mp3', 320).equivKbps, 128, 'a 128 inflated to 320')
  assert.equal(verdict('senza-dati/traccia01.mp3', 320).equivKbps, 80)
  assert.equal(verdict('lame320.mp3', 320).equivKbps, null)

  // Known miss: the album's AAC decoded to FLAC is not caught by the spectrum (the null test does it).
  if (NEA) {
    for (const [i, src] of songs().entries()) {
      const flac = await transcode(src, path.join(workDir(), 'nea-flac-' + i + '.flac'), [...a, '-c:a', 'flac'])
      const v = applyQuality({ lossless: true, codec: 'flac', bitDepth: 16, sampleRate: 44100 }, await measureQuality(ff, flac, durationOf(flac).duration))
      if (v.fakeLossless === false) misses.push(path.basename(src))
    }
    t.diagnostic('known miss, NEA AAC decoded to FLAC and taken as genuine (fakeLossless false): ' + misses.length + ' of 17: ' + misses.join(', '))
    assert.equal(misses.length, 17)
  }
})

test('[tool] the fingerprint compressed in JS from the raw items is fpcalc -json -length 120 on every file of the test folder', { skip: SKIP_MUSICA, timeout: 30 * 60000 }, async (t) => {
  const fps = await fingerprints()
  const files = audioFiles(MUSICA)
  assert.ok(files.length >= 18)
  for (const file of files) {
    const raw = await fps.compute(file)
    const { stdout } = await fps.runner.run(['-json', '-length', '120', file], { stdout: true, timeoutMs: 120000, lowPriority: false })
    const own = JSON.parse(stdout)
    assert.equal(compressFingerprint(raw.items), own.fingerprint, path.relative(MUSICA, file))
    assert.equal(raw.duration, Math.round(own.duration * 100) / 100)
  }
  t.diagnostic(files.length + ' files: equal')
})

test('[tool] the null test on the real files: the FLAC made from the album\'s AAC nulls against it and nothing else; through the pipeline it is "already there", and the other way the AAC replaces it', { skip: SKIP_MUSICA || (NEA ? false : 'the album: MPFY_NEA_DIR'), timeout: 30 * 60000 }, async (t) => {
  const ff = ffmpeg()
  const dop = (n) => path.join(MUSICA, 'doppioni', n)
  const fakeFlac = dop('Last Scene (FLAC finto, da AAC).flac')
  const lastScene = songs()[0]
  const pair = async (lossy, lossless) => nullTest(ff, { file: lossy, duration: durationOf(lossy).duration }, { file: lossless, duration: durationOf(lossless).duration })
  assert.equal(await pair(lastScene, fakeFlac), true, 'the FLAC is that AAC decoded')
  for (const other of [dop('Last Scene (mp3 192).mp3'), dop('Last Scene (opus 128).opus'), songs()[1]]) {
    assert.equal(await pair(other, fakeFlac), false, path.basename(other))
  }
  assert.equal(await pair(dop('Kokoro (mp3 320, dal FLAC).mp3'), kokoro(1)), false, 'an mp3 made FROM a FLAC: the FLAC is not its decode')

  const open = async (name) => {
    const dataDir = fs.mkdtempSync(path.join(workDir(), name + '-'))
    const app = await createMPfy({ dataDir, port: 0, adminPort: 0, p2p: false, debounceMs: 50, ffmpeg: env.MPFY_FFMPEG, fpcalc: env.MPFY_FPCALC, sevenZip: null, whoIs: testWhoIs })
    t.after(async () => {
      await app.close()
      fs.rmSync(dataDir, { recursive: true, force: true })
    })
    await app.jobsStarted
    app.people.openClaim(30)
    const owner = device(app, { profile: makeProfile(), name: 'Bacca' })
    assert.equal(json(await owner.call('GET', '/api/profile')).role, 'owner')
    return { app, owner }
  }
  const up = async (who, file) => {
    const r = await who.call('PUT', '/api/upload/' + encodeURIComponent(path.basename(file)), { body: fs.readFileSync(file), timeout: 600000 })
    assert.equal(r.status, 200, r.body.toString())
    return json(r)
  }
  // The AAC first, then its FLAC from someone else.
  const one = await open('null-a')
  const sara = device(one.app, { profile: makeProfile(), name: 'Sara' })
  const kept = (await up(one.owner, lastScene)).track
  let r = await up(sara, fakeFlac)
  t.diagnostic('the FLAC after its AAC: ' + r.outcome + ', kept ' + r.track.codec + ', score ' + r.track.score)
  assert.deepEqual([r.outcome, r.duplicate, r.track.id, r.track.codec], ['duplicate', true, kept.id, 'aac'], 'already there: the AAC stays')
  assert.ok(one.app.library.getTrack(kept.id).uploaders.includes(sara.profile.id), 'the claim is added as usual')
  assert.deepEqual(fs.readdirSync(one.app.library.libraryDir), [kept.id + '.m4a'])
  // The FLAC first, then its AAC: the AAC is the original, it replaces its bigger copy.
  const two = await open('null-b')
  const flac = (await up(two.owner, fakeFlac)).track
  assert.equal(flac.lossless, true)
  r = await up(two.owner, lastScene)
  t.diagnostic('the AAC after its FLAC: ' + r.outcome + ', kept ' + r.track.codec + ', score ' + r.track.score)
  assert.deepEqual([r.outcome, r.track.id, r.track.codec], ['replaced', flac.id, 'aac'])
  assert.ok(r.track.score > 300 && r.track.score < 400, 'an AAC of about 270 kbps: ' + r.track.score)
  assert.deepEqual(fs.readdirSync(two.app.library.libraryDir), [flac.id + '.m4a'])
  // The same FLAC at another compression level (other bytes, the same samples): a claim.
  const again = await transcode(fakeFlac, path.join(workDir(), 'last-scene-c0.flac'), ['-map', '0:a:0', '-vn', '-c:a', 'flac', '-compression_level', '0'])
  r = await up(two.owner, again)
  t.diagnostic('the same FLAC at compression level 0: ' + r.outcome + ', kept ' + r.track.codec)
  assert.deepEqual([r.outcome, r.track.id, r.track.codec], ['duplicate', flac.id, 'aac'])
})

test('[tool] one version on the real files: other codecs of a song are that version, down to AAC 64 and Opus 32, inverted or with a silence; the instrumental of a remix is not, even when the voice comes in late, and through the pipeline it never replaces the vocal mix, by its title or, without tags, by its sound', { skip: SKIP_MUSICA || (NEA ? false : 'the album: MPFY_NEA_DIR'), timeout: 30 * 60000 }, async (t) => {
  const ff = ffmpeg()
  const dop = (n) => path.join(MUSICA, 'doppioni', n)
  const info = (file) => ({ file, duration: durationOf(file).duration, lossless: /\.flac$/i.test(file) })
  const lastScene = songs()[0]
  const made = (name, input, args) => transcode(input, path.join(workDir(), name), ['-map', '0:a:0', '-vn', ...args])
  const gap = await made('last-scene-gap.flac', lastScene, ['-af', "volume=enable='between(t,44.2,45.8)':volume=0", '-c:a', 'flac'])
  const copies = [
    [lastScene, dop('Last Scene (mp3 192).mp3')],
    [lastScene, dop('Last Scene (opus 128).opus')],
    [lastScene, dop('Last Scene (FLAC finto, da AAC).flac')],
    [kokoro(1), dop('Kokoro (mp3 320, dal FLAC).mp3')],
    [kokoro(5), await made('kokoro-05-aac64.m4a', kokoro(5), ['-c:a', 'aac', '-b:a', '64k'])],
    [kokoro(9), await made('kokoro-09-opus32.opus', kokoro(9), ['-c:a', 'libopus', '-b:a', '32k'])],
    [kokoro(4), await made('kokoro-04-inverted.mp3', kokoro(4), ['-af', 'pan=stereo|c0=-1*c0|c1=-1*c1', '-c:a', 'libmp3lame', '-b:a', '192k'])],
    [gap, await made('last-scene-gap.mp3', gap, ['-c:a', 'libmp3lame', '-b:a', '192k'])]
  ]
  for (const [a, b] of copies) {
    const c = await compareFiles(ff, info(a), info(b))
    t.diagnostic(path.basename(b) + ': ' + JSON.stringify(c))
    assert.equal(c.sameVersion, true, path.basename(b))
  }
  const remix = await compareFiles(ff, info(kokoro(3)), info(kokoro(9)))
  t.diagnostic('03 against its instrumental 09: ' + JSON.stringify(remix))
  assert.equal(remix.sameVersion, false)
  // The instrumental for 65 s, then the vocal mix: the voice comes in at 1:05.
  const lateVoice = await transcode(kokoro(9), path.join(workDir(), 'kokoro-late-voice.flac'), ['-i', kokoro(3), '-filter_complex',
    '[0:a]atrim=0:65,asetpts=PTS-STARTPTS[a];[1:a]atrim=65,asetpts=PTS-STARTPTS[b];[a][b]concat=n=2:v=0:a=1[o]', '-map', '[o]', '-map_metadata', '-1', '-c:a', 'flac'])
  const late = await compareFiles(ff, info(kokoro(9)), info(lateVoice))
  t.diagnostic('09 against the voice from 1:05: ' + JSON.stringify(late))
  assert.equal(late.sameVersion, false)

  const dataDir = fs.mkdtempSync(path.join(workDir(), 'versions-'))
  const app = await createMPfy({ dataDir, port: 0, adminPort: 0, p2p: false, debounceMs: 50, ffmpeg: env.MPFY_FFMPEG, fpcalc: env.MPFY_FPCALC, sevenZip: null, whoIs: testWhoIs })
  t.after(async () => {
    await app.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  await app.jobsStarted
  app.people.openClaim(30)
  const owner = device(app, { profile: makeProfile(), name: 'Bacca' })
  assert.equal(json(await owner.call('GET', '/api/profile')).role, 'owner')
  const up = async (file, name = path.basename(file)) => {
    const r = await owner.call('PUT', '/api/upload/' + encodeURIComponent(name), { body: fs.readFileSync(file), timeout: 600000 })
    assert.equal(r.status, 200, r.body.toString())
    return json(r)
  }
  // With their tags: the titles tell them apart.
  const vocal = (await up(kokoro(3))).track
  let r = await up(kokoro(9))
  t.diagnostic('09 with its tags: ' + r.outcome)
  assert.equal(r.outcome, 'added')
  assert.equal(app.library.getTrack(vocal.id).fileHash, vocal.id, 'the vocal mix untouched')
  // Without tags and with plain names: the sound does.
  const bare = (n) => transcode(kokoro(n), path.join(workDir(), 'kokoro-' + n + '-bare.flac'), ['-map', '0:a:0', '-vn', '-map_metadata', '-1', '-c:a', 'flac'])
  const vocalBare = (await up(await bare(3), 'a.flac')).track
  r = await up(await bare(9), 'b.flac')
  t.diagnostic('09 without tags: ' + r.outcome)
  assert.equal(r.outcome, 'added')
  assert.equal(app.library.getTrack(vocalBare.id).fileHash, vocalBare.id, 'the vocal mix untouched')
  assert.equal(app.library.tracks.size, 4)

  // A library of its own: the instrumental (tagless, plain name), then the mix
  // whose voice comes in at 1:05, a better file with the same name.
  const dir2 = fs.mkdtempSync(path.join(workDir(), 'late-voice-'))
  const app2 = await createMPfy({ dataDir: dir2, port: 0, adminPort: 0, p2p: false, debounceMs: 50, ffmpeg: env.MPFY_FFMPEG, fpcalc: env.MPFY_FPCALC, sevenZip: null, whoIs: testWhoIs })
  t.after(async () => {
    await app2.close()
    fs.rmSync(dir2, { recursive: true, force: true })
  })
  await app2.jobsStarted
  app2.people.openClaim(30)
  const owner2 = device(app2, { profile: makeProfile(), name: 'Bacca' })
  assert.equal(json(await owner2.call('GET', '/api/profile')).role, 'owner')
  const up2 = async (file, name) => json(await owner2.call('PUT', '/api/upload/' + encodeURIComponent(name), { body: fs.readFileSync(file), timeout: 600000 }))
  const inst = (await up2(await transcode(kokoro(9), path.join(workDir(), 'kokoro-09-bare.mp3'), ['-map', '0:a:0', '-vn', '-map_metadata', '-1', '-c:a', 'libmp3lame', '-b:a', '320k']), 'Kokoro.mp3')).track
  r = await up2(lateVoice, 'Kokoro.flac')
  t.diagnostic('the voice from 1:05 after the instrumental: ' + r.outcome)
  assert.equal(r.outcome, 'added')
  assert.equal(app2.library.getTrack(inst.id).fileHash, inst.id, 'the instrumental untouched')
  assert.equal(app2.library.tracks.size, 2)
})

test('[tool][net] AcoustID and MusicBrainz on the tagless test files: traccia02 and traccia03 filled, traccia01 ambiguous, traccia04 (the album\'s Blue Regret, tags stripped) found nowhere; a tagged file asks nothing', { skip: SKIP_NET, timeout: 10 * 60000 }, async (t) => {
  const dataDir = fs.mkdtempSync(path.join(workDir(), 'net-'))
  const app = await createMPfy({ dataDir, port: 0, adminPort: 0, p2p: false, debounceMs: 50, ffmpeg: null, fpcalc: env.MPFY_FPCALC, sevenZip: null, whoIs: testWhoIs, detailsUrls: DETAILS_URLS })
  t.after(async () => {
    await app.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  await app.jobsStarted
  const up = async (file) => {
    const r = await request(app.ports.http, 'PUT', '/api/upload/' + encodeURIComponent(path.basename(file)), { body: fs.readFileSync(file), timeout: 120000 })
    assert.equal(r.status, 200, r.body.toString())
    return json(r).track
  }
  const dir = path.join(MUSICA, 'senza-dati')
  const ids = {}
  for (const n of ['traccia01.mp3', 'traccia02.mp3', 'traccia03.mp3', 'traccia04.m4a']) ids[n] = (await up(path.join(dir, n))).id
  const done = (id) => waitFor(() => {
    const tr = app.library.getTrack(id)
    return tr && tr.lookup ? tr : null
  }, { timeout: 120000, interval: 250, what: 'the lookup of ' + id })
  const t2 = await done(ids['traccia02.mp3'])
  assert.deepEqual([t2.title, t2.artist, t2.album, t2.albumArtist, t2.year, t2.trackNo], ['死ぬのがいいわ', '藤井風', 'HELP EVER HURT NEVER', '藤井風', 2020, 8])
  const t3 = await done(ids['traccia03.mp3'])
  assert.deepEqual([t3.title, t3.artist], ['AIZO', 'King Gnu'])
  const t1 = await done(ids['traccia01.mp3'])
  assert.deepEqual([t1.title, t1.artist, t1.lookup.state, t1.lookup.filled], ['traccia01', 'Artista sconosciuto', 'ambiguous', []])
  const t4 = await done(ids['traccia04.m4a'])
  assert.deepEqual([t4.title, t4.lookup.state, t4.lookup.filled], ['traccia04', 'nothing', []])
  for (const tr of [t1, t2, t3, t4]) t.diagnostic(tr.title + ' / ' + tr.artist + ' / ' + tr.album + ': ' + tr.lookup.state + ', filled ' + tr.lookup.filled.join(' ') + (tr.coverId ? ', cover' : ''))
  if (NEA) {
    const before = app.details.stats.requests
    const tagged = await up(songs()[0])
    await app.details.idle()
    assert.equal(app.library.getTrack(tagged.id).lookup, undefined)
    assert.equal(app.details.stats.requests, before, 'a tagged file with its cover: no request')
  }
})

// --------------------------------------------------------------- 7-Zip

function sevenZipRun (args) {
  const r = spawnSync(env.MPFY_7Z, args, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
  return { code: r.status, out: String(r.stdout) + String(r.stderr) }
}

function makeArchives () {
  const dir = workDir()
  const files = fs.readdirSync(NEA).map((n) => path.join(NEA, n))
  const out = {}
  const make = (name, args) => {
    const file = path.join(dir, name)
    if (!fs.existsSync(file)) {
      const r = sevenZipRun(['a', ...args, file, ...files])
      assert.equal(r.code, 0, name + ': ' + r.out.slice(-500))
    }
    out[name] = file
  }
  make('nea.zip', ['-tzip', '-mx5'])
  make('nea.7z', ['-t7z', '-mx9'])
  make('nea-enc.7z', ['-t7z', '-mx1', '-pSegreto', '-mhe=on'])
  make('nea-encfiles.7z', ['-t7z', '-mx1', '-pSegreto', '-mhe=off'])
  for (const name of ['nea.rar', 'nea-enc.rar', 'dict1536.7z']) {
    const file = FIXTURES ? path.join(FIXTURES, name) : ''
    if (file && fs.existsSync(file)) out[name] = file
  }
  return out
}

test('[tool] 7-Zip and yauzl on real archives of the album through the upload pipeline; encrypted ones refused; a 1536 MiB dictionary under the cap; the memory legit archives need', { skip: SKIP, timeout: 60 * 60000 }, async (t) => {
  const archives = makeArchives()
  const z = new SevenZip({ command: env.MPFY_7Z })
  assert.equal(await z.probe(), true, '7-Zip 25.01 or later')
  t.diagnostic('7-Zip ' + z.version + ', RAR ' + z.rar + ', prlimit ' + hasPrlimit())
  assert.equal(z.rar, true, 'Rar5 in the Codecs: section')
  const dataDir = fs.mkdtempSync(path.join(workDir(), 'data-'))
  const app = await createMPfy({
    dataDir, port: 0, adminPort: 0, p2p: false, debounceMs: 50, ffmpeg: env.MPFY_FFMPEG, fpcalc: env.MPFY_FPCALC, sevenZip: env.MPFY_7Z,
    sevenZipMemBytes: CAP, transcodeCapBytes: 0
  })
  t.after(async () => {
    await app.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  await app.jobsStarted
  const health = json(await request(app.ports.http, 'GET', '/api/health'))
  assert.deepEqual([health.fpcalc, health.archives], [true, { zip: true, sevenZip: true, rar: true }])
  const upload = async (file) => {
    const r = await request(app.ports.http, 'PUT', '/api/upload/' + encodeURIComponent(path.basename(file)), { body: fs.readFileSync(file), timeout: 600000 })
    assert.equal(r.status, 202, r.body.toString())
    const id = json(r).archive.id
    const st = await waitFor(async () => {
      const s = json(await request(app.ports.http, 'GET', '/api/archives/' + id))
      return s.state === 'done' || s.state === 'failed' ? s : null
    }, { timeout: 20 * 60000, interval: 500, what: 'the archive of ' + path.basename(file) })
    t.diagnostic(path.basename(file) + ': ' + JSON.stringify({ state: st.state, code: st.code, total: st.total, added: st.added, duplicates: st.duplicates, ignored: st.ignored }))
    return st
  }
  const zip = await upload(archives['nea.zip'])
  assert.deepEqual([zip.state, zip.total, zip.added, zip.ignored], ['done', 17, 17, 0], 'ZIP through yauzl')
  assert.ok(zip.coverId, 'cover.jpg is the archive cover')
  for (const id of zip.trackIds) {
    const tr = app.library.getTrack(id)
    assert.deepEqual([tr.codec, tr.fpState, tr.lossless], ['aac', 'ok', false])
  }
  const seven = await upload(archives['nea.7z'])
  assert.deepEqual([seven.state, seven.total, seven.duplicates], ['done', 17, 17], '7z: every entry byte identical to the ZIP\'s')
  if (archives['nea.rar']) {
    const rar = await upload(archives['nea.rar'])
    assert.deepEqual([rar.state, rar.total, rar.duplicates], ['done', 17, 17], 'RAR5')
  } else {
    t.diagnostic('no nea.rar fixture: RAR import not checked')
  }
  for (const name of ['nea-enc.7z', 'nea-encfiles.7z', 'nea-enc.rar']) {
    if (!archives[name]) continue
    const st = await upload(archives[name])
    assert.deepEqual([st.state, st.code], ['failed', 'archive_encrypted'], name)
  }
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'tmp')).filter((n) => /^[ax]-/.test(n)), [], 'no archive or extraction dir left in tmp/ (transcodes may be at work)')

  // A 1536 MiB dictionary over 1650 MiB of data (40:1, so the ratio rules let it
  // through to the extraction): refused by the memory cap, never by the phone.
  if (archives['dict1536.7z']) {
    const listing = await z.list(archives['dict1536.7z'])
    assert.ok(judgeListing(listing, fs.statSync(archives['dict1536.7z']).size).total > 1.5 * 1024 ** 3, 'it passes the listing rules')
    if (hasPrlimit()) {
      const st = await upload(archives['dict1536.7z'])
      assert.deepEqual([st.state, st.code], ['failed', 'archive_too_big'], 'out of memory under the cap')
    } else {
      t.diagnostic('no prlimit here: the 1536 MiB dictionary is checked on the phone')
    }
  }

  // What the legit archives need under prlimit --as: the cap must leave room.
  if (hasPrlimit()) {
    for (const name of ['nea.7z', 'nea.rar']) {
      if (!archives[name]) continue
      let lo = 16 * 1024 * 1024
      let hi = 4 * 1024 ** 3
      while (hi - lo > 4 * 1024 * 1024) {
        const mid = Math.floor((lo + hi) / 2)
        const r = spawnSync('prlimit', ['--as=' + mid, '--', env.MPFY_7Z, 't', '-pmpfy', archives[name]], { stdio: 'ignore', env: { ...process.env, MALLOC_ARENA_MAX: '2' } })
        if (r.status === 0) hi = mid
        else lo = mid
      }
      t.diagnostic(name + ' needs about ' + Math.round(hi / 1048576) + ' MiB of address space (cap ' + Math.round(CAP / 1048576) + ' MiB)')
      assert.ok(hi <= CAP, name + ' fits under MPFY_7Z_MEM_BYTES')
    }
  }
})
