// The real quality of a file: the spectrum (one ffmpeg decode, a JS FFT), the
// cutoff and its LAME class, the verdicts and the scores; the null test (a
// lossless file decoded from a lossy one); the upload pipeline and the
// background jobs with a fake ffmpeg that writes synthetic PCM (test/fake-ffmpeg.mjs).

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createMPfy } from '../server/app.mjs'
import { FfmpegRunner } from '../server/ffmpeg.mjs'
import { normalizeTrack } from '../server/library.mjs'
import {
  Spectrum, makeFft, makeRealPower, cutoffOf, classKbps, CUTOFF, applyQuality, scoreOf, isBetter, spectrumArgs,
  residualDb, nullResidual, nullArgs, nullStart, nullTest, decodeStereo, FRAME, QUALITY_V,
  compareFiles, sameVersion, versionOffset, versionArgs, spanDistances, versionVerdict, monoLag, BandFrames, VERSION_SAME_DB, VERSION_APART_DB, VERSION_RATE, VERSION_FRAME
} from '../server/quality.mjs'
import {
  tmpDir, cleanup, json, makeWav, makeMp3, makeAdts, makeOggOpus, makeProfile, device, testWhoIs, fakeTool, fakeFfmpeg, hash24, fingerprintOf, waitFor,
  CALIBRATION_VECTORS, treeFiles
} from './helpers.mjs'

const body = (r) => json(r)
const RATE = 44100

// The calibration vectors (C[0..39], dB under the 1-8 kHz band) measured on real files.
const VECTORS = CALIBRATION_VECTORS

// A sine at the centre of FFT bin k (so a Hann window keeps all of it in k - 1..k + 1).
function sine (k, amplitude, n, into = new Float32Array(n)) {
  const f = (k * RATE) / FRAME
  for (let i = 0; i < n; i++) into[i] += amplitude * Math.sin((2 * Math.PI * f * i) / RATE)
  return into
}

test('FFT: the real power spectrum is the plain DFT\'s', () => {
  const n = 64
  const x = Float64Array.from({ length: n }, (_, i) => Math.sin(i * 0.7) + 0.3 * Math.cos(i * 2.1) + (i % 5) / 10)
  const power = new Float64Array(n / 2 + 1)
  makeRealPower(n)(x, power)
  for (let k = 0; k <= n / 2; k++) {
    let re = 0
    let im = 0
    for (let i = 0; i < n; i++) {
      re += x[i] * Math.cos((2 * Math.PI * k * i) / n)
      im -= x[i] * Math.sin((2 * Math.PI * k * i) / n)
    }
    assert.ok(Math.abs(power[k] - (re * re + im * im)) < 1e-9, 'bin ' + k)
  }
  // Forward then inverse gives the signal back (times n).
  const re = Float64Array.from(x)
  const im = new Float64Array(n)
  const fft = makeFft(n)
  fft(re, im)
  fft(re, im, true)
  for (let i = 0; i < n; i++) assert.ok(Math.abs(re[i] / n - x[i]) < 1e-12)
})

test('spectrum: a sine near 1 kHz and one near 15 kHz 20 dB lower give their band levels within 0.5 dB; a partial last frame is dropped, however the bytes come', () => {
  const n = 40 * FRAME + 1000
  const x = sine(1400, 0.05, n, sine(95, 0.5, n)) // 1022.8 Hz and 15073.2 Hz
  const s = new Spectrum()
  s.pushSamples(x)
  assert.equal(s.frames, 40, 'the last 1000 samples are not a frame')
  const { C } = s.levels()
  assert.ok(Math.abs(C[26] - -20) <= 0.5, '15.0-15.5 kHz: ' + C[26])
  for (const [j, level] of C.entries()) if (j !== 26) assert.ok(level < -100, 'band ' + j + ': ' + level)
  // The same samples as f32le bytes in odd chunks.
  const bytes = Buffer.alloc(n * 4)
  for (let i = 0; i < n; i++) bytes.writeFloatLE(x[i], i * 4)
  const b = new Spectrum()
  for (let at = 0; at < bytes.length; at += 4093) b.push(bytes.subarray(at, at + 4093))
  assert.equal(b.frames, 40)
  assert.ok(Math.abs(b.levels().C[26] - C[26]) < 1e-6)
  assert.ok(Math.abs(b.rmsDb() - s.rmsDb()) < 1e-6)
})

test('spectrum: fewer than 32 frames, silence under -60 dBFS and nothing in the 1-8 kHz band are inconclusive', () => {
  const short = new Spectrum()
  short.pushSamples(sine(95, 0.5, 31 * FRAME))
  assert.equal(short.levels(), null, '31 frames')
  short.pushSamples(sine(95, 0.5, FRAME))
  assert.notEqual(short.levels(), null, '32 frames')
  const quiet = new Spectrum()
  quiet.pushSamples(sine(95, 0.0007, 40 * FRAME)) // RMS -63 dBFS
  assert.equal(quiet.levels(), null)
  const loud = new Spectrum()
  loud.pushSamples(sine(95, 0.0015, 40 * FRAME)) // RMS -59.5 dBFS
  assert.notEqual(loud.levels(), null)
  const noRef = new Spectrum()
  noRef.pushSamples(sine(95, 0.5, 40 * FRAME))
  noRef.power.fill(0)
  noRef.power[1600] = 1
  assert.equal(noRef.levels(), null, 'REF 0')
})

test('cutoff: the calibration vectors give their cutoffs, and each condition is caught by its mutant', () => {
  for (const [name, [want, C]] of Object.entries(VECTORS)) {
    assert.equal(C.length, 40, name)
    assert.equal(cutoffOf(C), want, name)
  }
  const at = (name, t) => cutoffOf(VECTORS[name][1], { ...CUTOFF, ...t })
  // Without the 6 dB step.
  assert.equal(at('lame320', { step: -Infinity }), 19500)
  assert.equal(at('opus128', { step: -Infinity }), 19500)
  // Without the 20 dB drop.
  assert.equal(at('dithered16k', { drop: -Infinity }), 17000)
  assert.equal(at('aacFromMp3', { drop: -Infinity }), 19500)
  assert.equal(at('natural', { drop: -Infinity }), 18500)
  // Without the floor guard (flat or deep).
  assert.equal(at('natural', { flat: Infinity }), 17500)
  // Without its flat branch, without its deep branch.
  assert.equal(at('dithered16k', { flat: -Infinity }), null)
  assert.equal(at('aacFromMp3', { flat: -Infinity }), null)
  assert.equal(at('lame128', { deep: Infinity }), null)
  assert.equal(at('yoru320', { deep: Infinity }), null)
})

test('cutoff: the LAME class on the table edges; a cut at 19000 (a floor of 4 bands) and at 19500 (3 bands) is found', () => {
  for (const [hz, kbps] of [[17000, 128], [17500, 160], [19000, 192], [19500, 256], [14500, 80], [5500, 32], [5000, 24], [15500, 112], [16000, 112], [18500, 192], [2500, 8]]) {
    assert.equal(classKbps(hz), kbps, hz + ' Hz')
  }
  const cut = (j) => Array.from({ length: 40 }, (_, i) => (i <= j ? -15 : -90))
  assert.equal(cutoffOf(cut(33)), 19000)
  assert.equal(cutoffOf(cut(34)), 19500)
  assert.equal(cutoffOf(cut(35)), null, 'a cut above 19.5 kHz is not measured')
})

test('verdicts: a lossy file is downgraded only at 80% of its bitrate or less; a lossless one is fake with its class; scores; what the labels read', () => {
  const lossy = (codec, kbps, cutoffHz) => applyQuality({ codec, bitrate: kbps * 1000, lossless: false }, { cutoffHz })
  let t = lossy('mp3', 320, 19500)
  assert.deepEqual([t.cutoffHz, t.equivKbps, t.score, t.qualityV], [19500, 256, 256, QUALITY_V], 'an mp3 320 cut at 19.5 kHz')
  t = lossy('mp3', 192, 19000)
  assert.deepEqual([t.equivKbps, t.score], [null, 192], 'an honest mp3 192')
  t = lossy('aac', 128, 17500)
  assert.deepEqual([t.equivKbps, t.score], [null, 166.4], 'an honest aac 128')
  t = lossy('opus', 256, 19000)
  assert.deepEqual([t.equivKbps, t.score], [192, 192], 'an Opus 256 made from an mp3 192: worth an mp3 192')
  const aac224 = lossy('aac', 224, null)
  assert.equal(aac224.score, 291.2)
  assert.equal(isBetter(t.score, aac224.score), false, 'never above a real AAC 224')
  const inflated = lossy('mp3', 320, 17000)
  assert.deepEqual([inflated.equivKbps, inflated.score], [128, 128])
  assert.equal(isBetter(lossy('aac', 256, null).score, inflated.score), true, 'a real AAC 256 (332.8) beats it')
  t = applyQuality({ codec: 'mp3', bitrate: 320000, lossless: false }, null)
  assert.deepEqual([t.cutoffHz, t.equivKbps, t.qualityV, t.score], [null, null, QUALITY_V, 320], 'inconclusive: no verdict, still this version')

  const flac = (cutoffHz, extra = {}) => applyQuality({ codec: 'flac', lossless: true, bitDepth: 16, sampleRate: 44100, ...extra }, cutoffHz === undefined ? null : { cutoffHz })
  t = flac(19000)
  assert.deepEqual([t.fakeLossless, t.equivKbps, t.score], [true, 192, 192])
  t = flac(null)
  assert.deepEqual([t.fakeLossless, t.equivKbps, t.score], [false, null, 1016441])
  t = flac(undefined)
  assert.deepEqual([t.fakeLossless, t.equivKbps, t.score], [null, null, 1016441], 'inconclusive')

  // What the labels read (codec, kbps or class, depth and rate), through the stored track.
  const stored = (t) => normalizeTrack({ id: 'a'.repeat(24), format: t.codec === 'flac' ? 'flac' : 'mp3', ...t })
  assert.deepEqual(pick(stored(lossy('mp3', 320, null))), { codec: 'mp3', bitrate: 320000, equivKbps: null, fakeLossless: null, cutoffHz: null }, 'MP3 320')
  assert.deepEqual(pick(stored(inflated)), { codec: 'mp3', bitrate: 320000, equivKbps: 128, fakeLossless: null, cutoffHz: 17000 }, 'MP3 ~128')
  assert.deepEqual(pick(normalizeTrack({ id: 'b'.repeat(24), format: 'm4a', ...lossy('aac', 320, 19000) })), { codec: 'aac', bitrate: 320000, equivKbps: 192, fakeLossless: null, cutoffHz: 19000 }, 'AAC ~192')
  assert.deepEqual(pick(stored(flac(19000))), { codec: 'flac', bitrate: null, equivKbps: 192, fakeLossless: true, cutoffHz: 19000 }, 'FLAC ~192')
  const hires = stored(flac(null, { bitDepth: 24, sampleRate: 96000 }))
  assert.deepEqual([hires.bitDepth, hires.sampleRate, hires.equivKbps, hires.fakeLossless], [24, 96000, null, false], 'FLAC 24/96')
})

function pick (t) {
  return { codec: t.codec, bitrate: t.bitrate, equivKbps: t.equivKbps, fakeLossless: t.fakeLossless, cutoffHz: t.cutoffHz }
}

test('stored fields: equivKbps from the LAME list only, cutoffHz a multiple of 500 in range, qualityV 0 when absent', () => {
  const base = { id: 'c'.repeat(24), format: 'mp3', codec: 'mp3', bitrate: 320000 }
  assert.equal(normalizeTrack({ ...base, equivKbps: 128 }).equivKbps, 128)
  assert.equal(normalizeTrack({ ...base, equivKbps: 130 }).equivKbps, null)
  assert.equal(normalizeTrack({ ...base, equivKbps: 320 }).equivKbps, null, 'never 320: the edge stops at 19.5 kHz')
  assert.equal(normalizeTrack({ ...base, cutoffHz: 17000 }).cutoffHz, 17000)
  for (const bad of [17250, 2000, 20000, '17000', null]) assert.equal(normalizeTrack({ ...base, cutoffHz: bad }).cutoffHz, null, String(bad))
  assert.equal(normalizeTrack(base).qualityV, 0)
  assert.equal(normalizeTrack({ ...base, qualityV: -1 }).qualityV, 0)
  assert.equal(normalizeTrack({ ...base, qualityV: 2 }).qualityV, 2)
  const flac = { id: 'd'.repeat(24), format: 'flac', lossless: true, bitDepth: 24, sampleRate: 44100 }
  assert.equal(normalizeTrack({ ...flac, fakeLossless: false, equivKbps: 192 }).equivKbps, null, 'a genuine file has no class')
})

test('the analysis decode: up to 60 s, from second 30 of a track of 90 s or more', () => {
  const tail = ['-map', '0:a:0', '-vn', '-ac', '1', '-ar', '44100', '-f', 'f32le', '-acodec', 'pcm_f32le', 'pipe:1']
  assert.deepEqual(spectrumArgs('/a.flac', 245), ['-nostdin', '-hide_banner', '-v', 'error', '-ss', '30', '-t', '60', '-i', '/a.flac', ...tail])
  assert.deepEqual(spectrumArgs('/a.flac', 89.9), ['-nostdin', '-hide_banner', '-v', 'error', '-t', '60', '-i', '/a.flac', ...tail])
  assert.deepEqual(spectrumArgs('/a.flac', null), ['-nostdin', '-hide_banner', '-v', 'error', '-t', '60', '-i', '/a.flac', ...tail])
  assert.deepEqual(nullArgs('/b.m4a', 30), ['-nostdin', '-hide_banner', '-v', 'error', '-i', '/b.m4a', '-map', '0:a:0', '-vn', '-ss', '30', '-t', '30',
    '-ac', '2', '-ar', '44100', '-f', 'f32le', '-acodec', 'pcm_f32le', 'pipe:1'])
  assert.equal(nullStart([224.9, 224.9]), 30)
  assert.equal(nullStart([224.9, 74]), 0)
  assert.equal(nullStart([224.9, null]), 0)
})

// Stereo noise (interleaved), about -20 dBFS, from a seed.
function noise (seed, frames) {
  const out = new Float32Array(frames * 2)
  let h = seed >>> 0
  for (let i = 0; i < out.length; i++) {
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0
    out[i] = (h / 4294967296 - 0.5) * 0.35
  }
  return out
}

test('null test: the same samples null out, also a few ms late, rounded to 16 bits or clipped at full scale; another file does not; silence and a short overlap tell nothing', () => {
  const frames = 3 * RATE
  const a = noise(1, frames)
  assert.equal(nullResidual(a, Float32Array.from(a)), -200)
  // 1105 samples late (an mp3 decoder that kept the encoder delay).
  const late = new Float32Array(a.length)
  late.set(a.subarray(0, a.length - 2 * 1105), 2 * 1105)
  assert.ok(residualDb(a, late, 0) > -10, 'not aligned: no null')
  assert.ok(nullResidual(a, late) <= -60, 'aligned by the correlation')
  // A 16-bit FLAC of the decode: the residual is the rounding.
  const rounded = a.map((v) => Math.round(v * 32767) / 32767)
  const r16 = nullResidual(a, rounded)
  assert.ok(r16 < -80 && r16 > -110, 'rounded: ' + r16)
  // Another encode of the same music is never that close: here, other noise.
  assert.ok(nullResidual(a, noise(2, frames)) > -10)
  // A loud decode overshoots 1.0; a 16 or 24-bit file of it holds 1.0 there.
  const loud = a.map((v) => v * 8)
  assert.ok(loud.some((v) => v > 1.2), 'overshoots')
  assert.equal(nullResidual(loud, loud.map((v) => Math.max(-1, Math.min(1, v)))), -200, 'clipped, still the same file')
  // The same music a little louder (a normalized file): not the same samples.
  assert.ok(nullResidual(a, a.map((v) => v * 1.12)) > -60)
  assert.equal(nullResidual(new Float32Array(a.length), new Float32Array(a.length)), null, 'silence')
  assert.equal(nullResidual(a.subarray(0, 2 * 40000), a.subarray(0, 2 * 40000)), null, 'under 1 s')
})

// A runner whose stream() hands over these floats as f32le, in chunks of `size`
// bytes through one buffer it reuses (a chunk is only valid while it is handed over).
function pcmRunner (byFile, size = 4099) {
  return {
    calls: [],
    async stream (args, onChunk) {
      const file = args[args.indexOf('-i') + 1]
      this.calls.push(file)
      const src = byFile[file]
      const bytes = Buffer.from(src.buffer, src.byteOffset, src.byteLength)
      const scratch = Buffer.alloc(size)
      for (let at = 0; at < bytes.length; at += size) {
        const n = bytes.copy(scratch, 0, at, Math.min(at + size, bytes.length))
        onChunk(scratch.subarray(0, n))
        scratch.fill(0x7f)
      }
      return { stderr: '', code: 0 }
    }
  }
}

test('null test: the threshold is 60 dB under the music: a copy 70 dB off is that file, 50 and 40 dB off it is not', async () => {
  const frames = 3 * RATE
  const a = noise(1, frames)
  const off = (db) => {
    const k = 10 ** (db / 20)
    const n = noise(7, frames)
    return a.map((v, i) => v + k * n[i])
  }
  for (const [db, same] of [[-70, true], [-65, true], [-55, false], [-50, false], [-40, false]]) {
    const runner = pcmRunner({ '/lossy.m4a': a, '/copy.flac': off(db) })
    assert.equal(await nullTest(runner, { file: '/lossy.m4a', duration: 3 }, { file: '/copy.flac', duration: 3 }), same, db + ' dB')
    assert.deepEqual(runner.calls, ['/lossy.m4a', '/copy.flac'])
  }
})

test('null test decode: the floats come out whole however the bytes are cut, no chunk is kept, at most 30 s', async () => {
  // The first sample that differs (-1: none), so a failure prints one number, not millions.
  const differs = (x, y) => x.length !== y.length ? 'length ' + x.length + ' vs ' + y.length : x.findIndex((v, i) => v !== y[i])
  const src = noise(3, 31 * RATE)
  const out = await decodeStereo(pcmRunner({ '/x.flac': src }), '/x.flac', 0)
  assert.equal(differs(out, src.subarray(0, 30 * RATE * 2)), -1)
  const odd = src.subarray(0, 2 * 1000 + 1)
  const whole = await decodeStereo(pcmRunner({ '/y.flac': odd }, 7), '/y.flac', 0)
  assert.equal(differs(whole, odd.subarray(0, 2 * 1000)), -1, 'whole frames only')
})

test('runner.stream: stdout handed over as it comes; the byte cap, the timeout and a reader that throws each kill it', async (t) => {
  const work = cleanup(t).dir(tmpDir('mpfy-stream-'))
  const ff = fakeFfmpeg(work, {})
  const input = path.join(work, 'in.bin')
  fs.writeFileSync(input, 'x')
  const runner = new FfmpegRunner({ command: ff.command })
  const args = spectrumArgs(input, 120)
  let bytes = 0
  await runner.stream(args, (c) => { bytes += c.length })
  assert.equal(bytes, 48 * FRAME * 4)
  await assert.rejects(runner.stream(args, () => {}, { maxBytes: 100000, quiet: true }), /too much output/)
  await assert.rejects(runner.stream(args, () => { throw new Error('no') }, { quiet: true }), /output not usable/)
  ff.control({ delayMs: 3000 })
  const t0 = Date.now()
  await assert.rejects(runner.stream(args, () => {}, { timeoutMs: 300, quiet: true }), /timeout/)
  assert.ok(Date.now() - t0 < 2500)
})

test('runner: a tool stopped through its signal is killed at once and fails as "stopped"; one stopped before it starts never runs', async (t) => {
  const work = cleanup(t).dir(tmpDir('mpfy-stop-'))
  const ff = fakeFfmpeg(work, { delayMs: 8000 })
  const input = path.join(work, 'in.bin')
  fs.writeFileSync(input, 'x')
  const runner = new FfmpegRunner({ command: ff.command })
  const calls = [
    (signal) => runner.stream(spectrumArgs(input, 120), () => {}, { signal }),
    (signal) => runner.run(['-nostdin', '-i', input, '-c:a', 'libopus', '-b:a', '96k', path.join(work, 'o.ogg')], { signal })
  ]
  for (const call of calls) {
    const stop = new AbortController()
    const t0 = Date.now()
    const running = call(stop.signal)
    setTimeout(() => stop.abort(), 300)
    await assert.rejects(running, /stopped/)
    assert.ok(Date.now() - t0 < 4000, 'killed, not waited for: ' + (Date.now() - t0) + ' ms')
  }
  const early = new AbortController()
  early.abort()
  await assert.rejects(runner.run(['-version'], { signal: early.signal }), /stopped/)
  assert.equal(ff.calls().length, 0, 'none ran to its end')
})

// --------------------------------------------------------------- one version

// Band energies of a made-up song, frame by frame (24 bands, lognormal), as
// BandFrames gives them.
function bandSong (seed, count) {
  let h = seed >>> 0
  const rnd = () => {
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0
    return h / 4294967296
  }
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd())
  const data = new Float32Array(count * 24)
  for (let i = 0; i < data.length; i++) data[i] = Math.exp(2 * gauss())
  return { data, count, gauss }
}
const bandMap = (f, fn) => ({ data: f.data.map(fn), count: f.count })
const SPAN_FRAMES = 42 * 11025 / 512 // 42 s: four spans of 10 s after the edges

test('one version: span by span; a copy or a louder one is that version, a little apart is still, more apart cannot tell, another song or a voice in one span alone is another version', () => {
  const count = Math.round(SPAN_FRAMES)
  const a = bandSong(1, count)
  const spans = (b) => spanDistances(a, b)
  const verdict = (b) => versionVerdict(spans(b))
  assert.equal(spans(bandMap(a, (v) => v)).length, 4)
  assert.equal(verdict(bandMap(a, (v) => v)), true)
  assert.equal(verdict(bandMap(a, (v) => v * 2)), true, 'one gain for the pair')
  const jitter = (amount, seed) => {
    const g = bandSong(seed, 1).gauss
    return bandMap(a, (v) => v * Math.exp(amount * g()))
  }
  const near = spans(jitter(0.4, 9))
  assert.ok(near.every((d) => d <= VERSION_SAME_DB && d > -13), 'about -10.8: ' + near)
  assert.equal(versionVerdict(near), true)
  const far = spans(jitter(0.7, 9))
  assert.ok(far.every((d) => d > VERSION_SAME_DB + 2 && d < VERSION_APART_DB - 1), 'about -5.3: ' + far)
  assert.equal(versionVerdict(far), null, 'between: cannot tell')
  const other = spans(bandSong(2, count))
  assert.ok(other.every((d) => d >= VERSION_APART_DB + 10), 'about +14: ' + other)
  assert.equal(versionVerdict(other), false)
  // A voice only in the last span: the other spans alike, that one apart.
  const late = bandMap(a, (v, i) => (Math.floor(i / 24) > count - 300 && i % 24 >= 4 && i % 24 < 16 ? v * 8 : v))
  const l = spans(late)
  assert.ok(l[l.length - 1] >= VERSION_APART_DB, String(l))
  assert.equal(versionVerdict(l), false)
  const back = spanDistances(late, a)
  assert.ok(back[back.length - 1] >= VERSION_APART_DB, 'the other way round too: ' + back)
})

test('one version: silence, too short or every span unreadable cannot tell; a span is judged on 40 loud frames or more', () => {
  const count = Math.round(SPAN_FRAMES)
  const a = bandSong(1, count)
  assert.deepEqual(spanDistances(a, { data: new Float32Array(count * 24), count }), [], 'the other file silent')
  assert.deepEqual(spanDistances({ data: new Float32Array(count * 24), count }, a), [], 'this one silent')
  assert.equal(versionVerdict(spanDistances(bandSong(3, 100), bandSong(3, 100))), null, 'under 5 s with the edges')
  assert.equal(versionVerdict([]), null)
  assert.equal(versionVerdict([null, null]), null)
  assert.equal(versionVerdict([null, -20]), true)
  assert.equal(versionVerdict([-20, -2]), false)
  assert.equal(versionVerdict([-20, -5]), null)
})

// Mono f32le at 11025 Hz handed over in odd chunks.
function feed (bands, mono) {
  const buf = Buffer.from(mono.buffer, mono.byteOffset, mono.byteLength)
  for (let at = 0; at < buf.length; at += 4099) bands.push(buf.subarray(at, Math.min(at + 4099, buf.length)))
  return bands.frames()
}
function monoNoise (seed, n, amp = 0.1) {
  const out = new Float32Array(n)
  let h = seed >>> 0
  for (let i = 0; i < n; i++) {
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0
    out[i] = (h / 4294967296 * 2 - 1) * amp
  }
  return out
}

test('one version: the band frames: a tone lands in its band, frames come every 512 samples, a skip drops samples and a negative one puts zeros first', () => {
  const R = VERSION_RATE
  const tone = new Float32Array(10 * R).map((_, i) => 0.5 * Math.sin((2 * Math.PI * 800 * i) / R))
  const f = feed(new BandFrames(), tone)
  assert.equal(f.count, Math.floor((tone.length - VERSION_FRAME) / 512) + 1)
  const row = f.data.subarray(50 * 24, 51 * 24)
  const top = row.indexOf(Math.max(...row))
  // 24 log-spaced bands from 150 Hz to 5 kHz: 800 Hz is in the middle of band 11 (11.46).
  assert.equal(top, Math.floor((24 * Math.log(800 / 150)) / Math.log(5000 / 150)))
  assert.ok(row[top] > 100 * (row.reduce((s, v) => s + v, 0) - row[top]), 'nearly all of it there')
  const x = monoNoise(4, 6 * R)
  const late = new Float32Array(x.length + 700)
  late.set(x, 700)
  const same = (p, q) => p.count === q.count && p.data.subarray(0, p.count * 24).every((v, i) => Math.abs(v - q.data[i]) <= 1e-3 * (1 + Math.abs(v)))
  const plain = feed(new BandFrames(), x)
  assert.ok(same(feed(new BandFrames(700), late), plain), 'skipping 700 samples lines it up')
  assert.ok(same(feed(new BandFrames(-700), x), feed(new BandFrames(), late)), '700 zeros first')
})

test('one version: the lag of two stretches, either sign (an inverted copy); none through silence', () => {
  const R = VERSION_RATE
  const x = monoNoise(5, 12 * R)
  const late = new Float32Array(x.length)
  late.set(x.subarray(0, x.length - 500), 500)
  assert.equal(monoLag(x, late, 3308), 500)
  assert.equal(monoLag(x, late.map((v) => -v), 3308), 500, 'inverted')
  assert.equal(monoLag(new Float32Array(x.length), x, 3308), null, 'silence')
  assert.equal(monoLag(x.subarray(0, 20000), x.subarray(0, 20000), 3308), null, 'too short')
})

// A runner that hands over these floats: `mono` for the version decodes (-ac 1),
// `stereo` for the null test's; it notes each file, start and length.
function decodeRunner ({ mono = {}, stereo = {} }) {
  return {
    calls: [],
    async stream (args, onChunk) {
      const file = args[args.indexOf('-i') + 1]
      const ac = args[args.indexOf('-ac') + 1]
      this.calls.push([file, ac, args[args.indexOf('-ss') + 1], args.includes('-t') ? args[args.indexOf('-t') + 1] : null])
      const src = (ac === '1' ? mono : stereo)[file]
      if (!src) throw new Error('no such file')
      const start = ac === '1' ? Math.round(Number(args[args.indexOf('-ss') + 1]) * VERSION_RATE) : 0
      const part = src.subarray(Math.min(src.length, start))
      onChunk(Buffer.from(part.buffer, part.byteOffset, part.byteLength))
      return { stderr: '', code: 0 }
    }
  }
}

test('versionOffset and compareFiles: the shift refined on a stretch that is not silent; the null test only once one version is shown; a decode that fails cannot tell', async () => {
  const R = VERSION_RATE
  // Noise whose loudness moves every 50 ms, so a misalignment shows.
  const song = monoNoise(6, 60 * R)
  const env = bandSong(8, Math.ceil(song.length / 551))
  for (let i = 0; i < song.length; i++) song[i] *= Math.sqrt(env.data[Math.floor(i / 551) * 24]) / 4
  // The kept file starts 0.4 s later and holds the same song.
  const kept = new Float32Array(song.length + Math.round(0.4 * R))
  kept.set(song, Math.round(0.4 * R))
  const lossy = (file, duration = 60) => ({ file, duration, lossless: false })
  const lossless = (file, duration = 60) => ({ file, duration, lossless: true })
  let r = decodeRunner({ mono: { '/a.mp3': song, '/b.flac': kept } })
  // The fingerprints say 0.37 s (three items); the stretch says 4410 samples.
  assert.equal(await versionOffset(r, lossy('/a.mp3'), lossless('/b.flac'), 0.37), Math.round(0.4 * R))
  assert.deepEqual(r.calls.slice(0, 2).map((c) => [c[0], c[1], c[3]]), [['/a.mp3', '1', '12'], ['/b.flac', '1', '12']])
  // Lined up by that offset, the whole of both is one version; 0.4 s off it is not.
  r = decodeRunner({ mono: { '/a.mp3': song, '/b.flac': kept } })
  assert.equal(await sameVersion(r, lossy('/a.mp3'), lossless('/b.flac'), 0.37), true)
  const off = spanDistances(feed(new BandFrames(), song), feed(new BandFrames(), kept))
  assert.equal(versionVerdict(off), false, 'not lined up: ' + off)
  // A silent middle: the next place is tried.
  const holed = Float32Array.from(song)
  holed.fill(0, 20 * R, 40 * R)
  r = decodeRunner({ mono: { '/a.mp3': holed, '/b.mp3': holed } })
  assert.equal(await versionOffset(r, lossy('/a.mp3'), lossy('/b.mp3'), 0), 0)
  assert.ok(r.calls.length > 2, 'more than one place: ' + r.calls.length)

  // compareFiles: one version, then the null test on 30 s of stereo.
  const stereoOf = (m) => {
    const out = new Float32Array(m.length * 2)
    for (let i = 0; i < m.length; i++) out[2 * i] = out[2 * i + 1] = m[i]
    return out
  }
  const s = stereoOf(monoNoise(7, 3 * 44100))
  r = decodeRunner({ mono: { '/a.mp3': song, '/b.flac': song }, stereo: { '/a.mp3': s, '/b.flac': s } })
  assert.deepEqual(await compareFiles(r, lossy('/a.mp3'), lossless('/b.flac')), { sameVersion: true, decoded: true })
  r = decodeRunner({ mono: { '/a.mp3': song, '/b.flac': song }, stereo: { '/a.mp3': s, '/b.flac': s.map((v) => v * 1.2) } })
  assert.deepEqual(await compareFiles(r, lossy('/a.mp3'), lossless('/b.flac')), { sameVersion: true, decoded: false }, 'louder: other samples')
  r = decodeRunner({ mono: { '/a.mp3': song, '/b.mp3': song } })
  assert.deepEqual(await compareFiles(r, lossy('/a.mp3'), lossy('/b.mp3')), { sameVersion: true, decoded: null }, 'two lossy files: no null test')
  assert.ok(r.calls.every((c) => c[1] === '1'), 'nothing decoded for it')
  r = decodeRunner({ mono: { '/a.mp3': song, '/b.flac': new Float32Array(song.length) }, stereo: { '/a.mp3': s, '/b.flac': s } })
  assert.deepEqual(await compareFiles(r, lossy('/a.mp3'), lossless('/b.flac')), { sameVersion: null, decoded: null }, 'silence: no null test either')
  r = decodeRunner({ mono: { '/a.mp3': song } })
  assert.deepEqual(await compareFiles(r, lossy('/a.mp3'), lossless('/gone.flac')), { sameVersion: null, decoded: null }, 'a decode that fails cannot tell')
  assert.deepEqual(versionArgs('/x.flac'), ['-nostdin', '-hide_banner', '-v', 'error', '-ss', '0', '-t', '1200', '-i', '/x.flac', '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '11025', '-f', 'f32le', '-acodec', 'pcm_f32le', 'pipe:1'])
})

// ------------------------------------------------------------ the source

async function start (t, { fp = {}, ff = {}, dir = null, opts = {}, profile = null } = {}) {
  const c = cleanup(t)
  const dataDir = dir || c.dir(tmpDir())
  const work = c.dir(tmpDir('mpfy-q-'))
  const fpcalc = fakeTool(work, 'fpcalc', fp)
  const ffmpeg = fakeFfmpeg(work, ff)
  const app = c.close(await createMPfy({
    dataDir, port: 0, adminPort: 0, p2p: false, debounceMs: 10, ffmpeg: ffmpeg.command, fpcalc: fpcalc.command, sevenZip: null, whoIs: testWhoIs, ...opts
  }))
  await app.jobsStarted
  if (profile === null) app.people.openClaim(30)
  const owner = device(app, { profile: profile || makeProfile(), name: 'Bacca' })
  assert.equal(body(await owner.call('GET', '/api/profile')).role, 'owner')
  return { app, dir: dataDir, owner, ff: ffmpeg, fpcalc }
}

// Files of one recording: each the same fingerprint (a bit or two apart) and length.
function prints (seed, files, duration) {
  const out = {}
  files.forEach((buf, i) => { out[hash24(buf)] = { duration, fingerprint: fingerprintOf(seed, { flip: i }) } })
  return out
}

const decodes = (ff, channels) => ff.calls().filter((c) => c.args.includes('f32le') && c.args[c.args.indexOf('-ac') + 1] === String(channels))

test('dedup on the real quality: an inflated mp3 320 gives way to a real AAC 256, never the reverse; an Opus 256 cut at 19 kHz never beats a real AAC 224', async (t) => {
  const inflated = makeMp3({ frames: 400, kbps: 320, title: 'Gonfiato' })
  const aac256 = makeAdts({ frames: 400, frameLength: 743 })
  const aac256b = makeAdts({ frames: 400, frameLength: 742 })
  const inflated2 = makeMp3({ frames: 400, kbps: 320, title: 'Gonfiato 2' })
  const aac224 = makeAdts({ frames: 400, frameLength: 650 })
  const opus = makeOggOpus({ seconds: 9.3, kbps: 256 })
  const fp = { prints: { ...prints('uno', [inflated, aac256], 10.4), ...prints('due', [aac256b, inflated2], 9.3), ...prints('tre', [aac224, opus], 9.3) } }
  // One recording, one version: the same samples where the voice sits, each file with its own cut.
  const cut = (seed, cutoffHz = null) => ({ seed, cutoffHz, floorDb: -95 })
  const pcmFor = {
    [hash24(inflated)]: cut('uno', 17000), [hash24(aac256)]: cut('uno'),
    [hash24(aac256b)]: cut('due'), [hash24(inflated2)]: cut('due', 17000),
    [hash24(aac224)]: cut('tre'), [hash24(opus)]: cut('tre', 19000)
  }
  const { app, owner } = await start(t, { fp, ff: { pcmFor } })

  const kept = body(await owner.call('PUT', '/api/upload/gonfiato.mp3', { body: inflated })).track
  await app.jobs.idle()
  let now = app.library.getTrack(kept.id)
  assert.deepEqual([now.cutoffHz, now.equivKbps, now.score], [17000, 128, 128], 'the upload is analysed in the background')
  let r = body(await owner.call('PUT', '/api/upload/vero.aac', { body: aac256 }))
  assert.deepEqual([r.outcome, r.track.id, r.track.codec], ['replaced', kept.id, 'aac'], 'a real AAC 256 (332.8) replaces it')
  assert.deepEqual([r.track.cutoffHz, r.track.equivKbps], [null, null], 'analysed while deciding: no cut')

  const keptAac = body(await owner.call('PUT', '/api/upload/vero2.aac', { body: aac256b })).track
  r = body(await owner.call('PUT', '/api/upload/gonfiato2.mp3', { body: inflated2 }))
  assert.deepEqual([r.outcome, r.track.id, r.track.codec], ['duplicate', keptAac.id, 'aac'], 'the inflated mp3 never replaces a real AAC')

  const keptAac224 = body(await owner.call('PUT', '/api/upload/vero224.aac', { body: aac224 })).track
  r = body(await owner.call('PUT', '/api/upload/opus.opus', { body: opus }))
  assert.deepEqual([r.outcome, r.track.id, r.track.codec], ['duplicate', keptAac224.id, 'aac'], 'an Opus 256 worth an mp3 192 stays under an AAC 224 (291.2)')
  now = app.library.getTrack(keptAac224.id)
  assert.deepEqual([now.equivKbps, now.qualityV], [null, QUALITY_V], 'the kept track was analysed too')
  assert.ok(now.score > 291 && now.score < 292, 'an AAC 224: ' + now.score)
})

test('the analysis: at most 60 s, from second 30 at 90 s or more; a track of 80 s and one of unknown length get a verdict; every run ends with this version, inconclusive included', async (t) => {
  const short = makeWav({ seconds: 80, sampleRate: 1000, freq: 101 })
  const long = makeWav({ seconds: 95, sampleRate: 1000, freq: 103 })
  const other = makeWav({ seconds: 3, sampleRate: 44100, freq: 107 })
  const silent = makeWav({ seconds: 3, sampleRate: 44100, freq: 109 })
  const pcmFor = { [hash24(short)]: { cutoffHz: 16000 }, [hash24(long)]: { cutoffHz: 19000 }, [hash24(other)]: { cutoffHz: 17500 }, [hash24(silent)]: { silent: true } }
  const { app, owner, ff } = await start(t, { ff: { pcmFor } })
  // A lossless WAV under 44.1 kHz is not analysed: it only gets the version.
  const s = body(await owner.call('PUT', '/api/upload/corto.wav', { body: short })).track
  await app.jobs.idle()
  assert.deepEqual([app.library.getTrack(s.id).qualityV, app.library.getTrack(s.id).fakeLossless], [QUALITY_V, null])
  assert.equal(decodes(ff, 1).length, 0)
  // As if they were at 44.1 kHz: 80 s, 95 s, unknown.
  for (const [buf, name] of [[short, 's.wav'], [long, 'l.wav']]) {
    const tr = app.library.getTrack(hash24(buf)) || app.library.getTrack(body(await owner.call('PUT', '/api/upload/' + name, { body: buf })).track.id)
    app.library.setTrack({ ...tr, sampleRate: 44100, qualityV: 0 })
    app.jobs.requestQuality(app.library.getTrack(tr.id))
  }
  await app.jobs.idle()
  const calls = decodes(ff, 1)
  assert.equal(calls.length, 2)
  assert.ok(calls[0].args.includes('-t') && calls[0].args[calls[0].args.indexOf('-t') + 1] === '60' && !calls[0].args.includes('-ss'), '80 s: from the start, 60 s')
  assert.deepEqual(calls[1].args.slice(4, 8), ['-ss', '30', '-t', '60'], '95 s: from second 30')
  assert.equal(app.library.getTrack(hash24(short)).cutoffHz, 16000)
  assert.deepEqual([app.library.getTrack(hash24(long)).fakeLossless, app.library.getTrack(hash24(long)).equivKbps], [true, 192])

  const o = body(await owner.call('PUT', '/api/upload/o.wav', { body: other })).track
  await app.jobs.idle()
  app.library.setTrack({ ...app.library.getTrack(o.id), duration: null, qualityV: 0 })
  app.jobs.requestQuality(app.library.getTrack(o.id))
  await app.jobs.idle()
  const last = decodes(ff, 1).pop()
  assert.ok(!last.args.includes('-ss') && last.args[last.args.indexOf('-t') + 1] === '60', 'no duration: from the start, 60 s')
  assert.deepEqual([app.library.getTrack(o.id).cutoffHz, app.library.getTrack(o.id).equivKbps], [17500, 160])

  const q = body(await owner.call('PUT', '/api/upload/q.wav', { body: silent })).track
  await app.jobs.idle()
  const tq = app.library.getTrack(q.id)
  assert.deepEqual([tq.qualityV, tq.fakeLossless, tq.cutoffHz], [QUALITY_V, null, null], 'silence: no verdict, and no retry')
  const before = decodes(ff, 1).length
  app.jobs.requestQuality(tq)
  await app.jobs.idle()
  assert.equal(decodes(ff, 1).length, before)
})

test('a library from before: every track analysed once in the background (cutoff and class returned, the version moved); a restart analyses nothing', async (t) => {
  const c = cleanup(t)
  const dir = c.dir(tmpDir())
  const a = makeMp3({ frames: 200, kbps: 320, title: 'Uno' })
  const b = makeWav({ seconds: 3, sampleRate: 44100, freq: 211 })
  // Made with this server, then turned into a db.json from before (no analysis fields, the old verdicts).
  let first = await start(t, { dir, opts: { ffmpeg: null } })
  await first.owner.call('PUT', '/api/upload/a.mp3', { body: a })
  await first.owner.call('PUT', '/api/upload/b.wav', { body: b })
  await first.app.library.exportCompat()
  await first.app.close()
  const dbFile = path.join(dir, 'db.json')
  const db = JSON.parse(fs.readFileSync(dbFile, 'utf8'))
  for (const tr of db.tracks) {
    for (const k of ['qualityV', 'cutoffHz', 'tagless', 'edited']) delete tr[k]
    tr.qualityChecked = true
    if (tr.lossless) Object.assign(tr, { fakeLossless: true, equivKbps: 192 })
  }
  fs.writeFileSync(dbFile, JSON.stringify(db))

  const pcmFor = { [hash24(a)]: { cutoffHz: 17000 }, [hash24(b)]: { cutoffHz: null } }
  const profile = first.owner.profile
  first = await start(t, { dir, ff: { pcmFor }, opts: { backgroundDelayMs: 400 }, profile })
  const startVersion = first.app.library.version
  await waitFor(() => [...first.app.library.tracks.values()].every((tr) => tr.qualityV === QUALITY_V), { what: 'every track analysed' })
  await first.app.jobs.idle()
  const lib = body(await first.owner.call('GET', '/api/library'))
  assert.ok(lib.version > startVersion, 'the version moved')
  const byId = Object.fromEntries(lib.tracks.map((x) => [x.id, x]))
  assert.deepEqual([byId[hash24(a)].cutoffHz, byId[hash24(a)].equivKbps, byId[hash24(a)].score], [17000, 128, 128], 'the mp3 320 is an inflated 128')
  assert.deepEqual([byId[hash24(b)].fakeLossless, byId[hash24(b)].equivKbps, byId[hash24(b)].score], [false, null, 1016441], 'the old verdict replaced')
  for (const tr of first.app.library.tracks.values()) assert.equal(tr.qualityV, QUALITY_V)
  assert.equal(decodes(first.ff, 1).length, 2, 'each once')
  await first.app.close()

  const again = await start(t, { dir, ff: { pcmFor }, profile })
  await again.app.jobs.idle()
  assert.equal(decodes(again.ff, 1).length, 0, 'nothing analysed twice')
})

test('null test: a lossless file decoded from a lossy one is only a bigger copy of it: after its original a claim, before it replaced by it; a genuine lossless file still replaces the original', async (t) => {
  const aac = makeAdts({ frames: 200, frameLength: 760 }) // AAC 262 kbps: 341.2
  const wav = makeWav({ seconds: 4.6, sampleRate: 44100, freq: 311 })
  const wav2 = makeWav({ seconds: 4.6, sampleRate: 44100, freq: 313 })
  const wav2again = makeWav({ seconds: 4.6, sampleRate: 44100, freq: 314 })
  const aac2 = makeAdts({ frames: 200, frameLength: 761 })
  const genuine = makeWav({ seconds: 4.6, sampleRate: 44100, freq: 317 })
  const fp = { prints: { ...prints('nea', [aac, wav], 4.6), ...prints('nea2', [wav2, aac2, wav2again, genuine], 4.6) } }
  // The lossy files and the lossless ones decoded from them hold the same samples,
  // up to 20.5 kHz (past what the analysis can tell from genuine); the genuine
  // file is the same version, with the band above too.
  const lossy = (seed) => ({ seed, cutoffHz: 20500 })
  const pcmFor = {
    [hash24(aac)]: lossy('nea'), [hash24(wav)]: lossy('nea'),
    [hash24(wav2)]: lossy('nea2'), [hash24(aac2)]: lossy('nea2'), [hash24(wav2again)]: lossy('nea2'),
    [hash24(genuine)]: { seed: 'nea2' }
  }
  const { app, owner, ff } = await start(t, { fp, ff: { pcmFor } })
  const sara = device(app, { profile: makeProfile(), name: 'Sara' })
  const filesOf = (id) => treeFiles(app.library.dataDir, 'library').filter((n) => n.startsWith(id))

  // The original first: the lossless copy is already there.
  const kept = body(await owner.call('PUT', '/api/upload/' + encodeURIComponent('01 Last Scene.aac'), { body: aac })).track
  await app.jobs.idle()
  let r = body(await sara.call('PUT', '/api/upload/' + encodeURIComponent('Last Scene (FLAC finto).wav'), { body: wav }))
  assert.deepEqual([r.outcome, r.duplicate, r.track.id, r.track.codec], ['duplicate', true, kept.id, 'aac'], 'already there: the lossless copy is worth the AAC')
  assert.ok(app.library.getTrack(kept.id).uploaders.includes(sara.profile.id), 'the claim is added as usual')
  assert.deepEqual(filesOf(kept.id), [kept.id + '.aac'])
  const pairs = decodes(ff, 2)
  assert.equal(pairs.length, 2, 'both decoded once')
  assert.deepEqual(pairs.map((c) => c.args.slice(9, 13)), [['-ss', '0', '-t', '30'], ['-ss', '0', '-t', '30']], 'the same span of both')
  assert.equal(pairs[1].args[pairs[1].args.indexOf('-i') + 1], app.library.trackPath(app.library.getTrack(kept.id)), 'the upload first, then the kept file')

  // The copy first: alone it looks genuine; its original replaces it.
  const keptWav = body(await owner.call('PUT', '/api/upload/finto.wav', { body: wav2 })).track
  await app.jobs.idle()
  assert.equal(app.library.getTrack(keptWav.id).score, 1016441, 'alone it looks genuine')
  r = body(await owner.call('PUT', '/api/upload/vero.aac', { body: aac2 }))
  assert.deepEqual([r.outcome, r.track.id, r.track.codec], ['replaced', keptWav.id, 'aac'], 'the original replaces its bigger copy')
  assert.ok(r.track.score > 340 && r.track.score < 342, 'an AAC 262: ' + r.track.score)
  assert.deepEqual(filesOf(keptWav.id), [keptWav.id + '.aac'])
  // The same decode again (other bytes: retagged, another compression level) is a claim.
  r = body(await owner.call('PUT', '/api/upload/finto-ritaggato.wav', { body: wav2again }))
  assert.deepEqual([r.outcome, r.track.id, r.track.codec], ['duplicate', keptWav.id, 'aac'], 'never taken for a genuine lossless file')
  // A genuine lossless file of that version replaces the original.
  r = body(await owner.call('PUT', '/api/upload/genuino.wav', { body: genuine }))
  assert.deepEqual([r.outcome, r.track.id, r.track.score], ['replaced', keptWav.id, 1016441])
})
