// A fake ffmpeg for the tests (ffmpeg is not installed on the build PC). The
// server runs it as MPFY_FFMPEG (a .mjs command is run with Node).
//
// Behaviour, read at every call from fake-ffmpeg.json NEXT TO THIS FILE (each test
// copies this script into its own temp dir, so tests never share a control file):
//   { "delayMs": 0,          wait this long before writing the output
//     "delayFor": { "<substring>": ms }, the same, only for calls with an
//                            argument containing it
//     "inputFirst": false,   look for the input before the delay, as the real
//                            one opens it at once (else after it)
//     "fail": null,          substring: any argument containing it makes the call fail
//     "noOpus": false,       -encoders does not list libopus
//     "garbage": false,      write an output that is neither Ogg nor JPEG
//     "bytesPerKbps": 100,   size of a transcode: kbps * bytesPerKbps
//     "pcm": { "cutoffHz": 17000, "floorDb": -95, "seed": "x", "silent": false },
//                            what a decode to f32le gives: noise flat up to the
//                            cutoff (null or absent: to 22 kHz), a flat floor
//                            floorDb under it above; files with the same seed
//                            decode to the same samples (the null test), the
//                            default seed is the input's sha24; "gap": [fromHz,
//                            toHz] leaves that part of the band out; frequencies
//                            are at the rate asked with -ar (44.1 kHz without)
//     "pcmFor": { "<sha24 of the input>": { ...the same } },
//     "loudness": [lufs, peak]   what ebur128 says of every input ([-9.5, -0.3] without),
//     "loudnessFor": { "<sha24>": [lufs, peak] | "none" } }
// Every call appends one JSON line { args, start, end } to fake-ffmpeg-calls.log
// when it ends, and { args, start } to fake-ffmpeg-started.log once it has read
// its control (next to this file too).
//
// Outputs are deterministic: a transcode is "OggS" + the input's base name and the
// bitrate, repeated to the size; a cover is a JPEG header + the scale argument and
// the input's base name; a tail cut (-sseof) is "TAIL:" + the input's sha24, which
// the fake fpcalc reads back; a decode to f32le is 48 frames of 4096 mono samples,
// or 3 s of stereo with -ac 2.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const start = Date.now()

let control = {}
try {
  control = JSON.parse(fs.readFileSync(path.join(here, 'fake-ffmpeg.json'), 'utf8'))
} catch {}

fs.appendFileSync(path.join(here, 'fake-ffmpeg-started.log'), JSON.stringify({ args, start }) + '\n')

function record () {
  fs.appendFileSync(path.join(here, 'fake-ffmpeg-calls.log'), JSON.stringify({ args, start, end: Date.now() }) + '\n')
}

function finish (code, message) {
  record()
  if (message) process.stderr.write(message + '\n')
  process.exit(code)
}

if (args.includes('-encoders')) {
  process.stdout.write('Encoders:\n V....D mjpeg                MJPEG (Motion JPEG)\n' +
    (control.noOpus ? '' : ' A....D libopus              libopus Opus (codec opus)\n'))
  finish(0)
}
if (args.includes('-version')) {
  process.stdout.write('ffmpeg version 0.0-fake\n')
  finish(0)
}

// ------------------------------------------------------------------ PCM

const RATE = 44100
const BLOCK = 65536

function fft (re, im, inverse) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t
      t = im[i]; im[i] = im[j]; im[j] = t
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / size
    for (let i = 0; i < n; i += size) {
      for (let k = 0; k < size / 2; k++) {
        const c = Math.cos(ang * k)
        const s = Math.sin(ang * k)
        const a = i + k
        const b = a + size / 2
        const tr = re[b] * c - im[b] * s
        const ti = re[b] * s + im[b] * c
        re[b] = re[a] - tr
        im[b] = im[a] - ti
        re[a] += tr
        im[a] += ti
      }
    }
  }
}

function prng (seed) {
  let h = crypto.createHash('sha256').update('fake-pcm:' + seed).digest().readUInt32LE(0)
  return () => {
    h = (h + 0x6d2b79f5) >>> 0
    let t = h
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// One block of noise, flat to the cutoff, the floor above, RMS about -20 dBFS.
function block ({ cutoffHz = null, floorDb = -95, seed, gap = null, rate = RATE }) {
  const re = new Float64Array(BLOCK)
  const im = new Float64Array(BLOCK)
  const rnd = prng(seed)
  const floor = Math.pow(10, floorDb / 20)
  for (let k = 1; k < BLOCK / 2; k++) {
    const f = (k * rate) / BLOCK
    // Like an encoder's lowpass, the music ends a little under the edge; a gap
    // is a part of the band that is not there (a voice taken away).
    const inGap = gap !== null && f >= gap[0] && f < gap[1]
    const mag = (cutoffHz === null || f < cutoffHz - 100) && !inGap ? 1 : floor
    const phase = 2 * Math.PI * rnd()
    re[k] = mag * Math.cos(phase)
    im[k] = mag * Math.sin(phase)
    re[BLOCK - k] = re[k]
    im[BLOCK - k] = -im[k]
  }
  fft(re, im, true)
  let sq = 0
  for (let i = 0; i < BLOCK; i++) sq += re[i] * re[i]
  const scale = 0.1 / Math.sqrt(sq / BLOCK)
  const out = new Float32Array(BLOCK)
  for (let i = 0; i < BLOCK; i++) out[i] = re[i] * scale
  return out
}

function pcm (input, channels, rate) {
  const sha24 = crypto.createHash('sha256').update(fs.readFileSync(input)).digest('hex').slice(0, 24)
  const spec = { ...(control.pcm || {}), ...((control.pcmFor || {})[sha24] || {}) }
  const samples = channels === 2 ? 3 * RATE : 48 * 4096
  const out = Buffer.alloc(samples * channels * 4)
  if (spec.silent) return out
  const one = block({ cutoffHz: spec.cutoffHz === undefined ? null : spec.cutoffHz, floorDb: spec.floorDb === undefined ? -95 : spec.floorDb, seed: spec.seed || sha24, gap: spec.gap || null, rate })
  for (let i = 0; i < samples; i++) {
    for (let c = 0; c < channels; c++) out.writeFloatLE(one[i % BLOCK], (i * channels + c) * 4)
  }
  return out
}

const inputAt = args.indexOf('-i')
const inputFound = inputAt !== -1 && fs.existsSync(args[inputAt + 1])

setTimeout(() => {
  if (control.fail && args.some((a) => a.includes(control.fail))) finish(1, 'fake ffmpeg: failing on purpose (' + control.fail + ')')
  const i = args.indexOf('-i')
  const input = i === -1 ? null : args[i + 1]
  const output = args[args.length - 1]
  if (!input || !(control.inputFirst ? inputFound : fs.existsSync(input))) finish(1, input + ': No such file or directory')
  const name = path.basename(input)
  const sha24 = () => crypto.createHash('sha256').update(fs.readFileSync(input)).digest('hex').slice(0, 24)
  if (args[args.indexOf('-f') + 1] === 'f32le' && output === 'pipe:1') {
    const ac = args.indexOf('-ac') === -1 ? 1 : Number(args[args.indexOf('-ac') + 1])
    const ar = args.indexOf('-ar') === -1 ? RATE : Number(args[args.indexOf('-ar') + 1])
    process.stdout.write(pcm(input, ac, ar), () => finish(0))
    return
  }
  if (args.some((a) => a.startsWith('ebur128'))) {
    const v = (control.loudnessFor || {})[sha24()] || control.loudness || [-9.5, -0.3]
    if (v === 'none') return process.stderr.write('no summary\n', () => finish(0))
    const text = '[Parsed_ebur128_0 @ 0x1] Summary:\n\n  Integrated loudness:\n    I:         ' + v[0].toFixed(1) + ' LUFS\n    Threshold: ' + (v[0] - 10).toFixed(1) + ' LUFS\n\n  Loudness range:\n    LRA:         5.0 LU\n\n  Sample peak:\n    Peak:      ' + v[1].toFixed(1) + ' dBFS\n'
    return process.stderr.write(text, () => finish(0))
  }
  let data
  if (args.includes('-sseof')) {
    data = Buffer.from('TAIL:' + sha24())
  } else if (control.garbage) {
    data = Buffer.from('not media at all ' + name)
  } else if (args.includes('libopus')) {
    const rate = args[args.indexOf('-b:a') + 1]
    const size = parseInt(rate, 10) * (control.bytesPerKbps || 100)
    const unit = Buffer.from('OggS fake opus ' + rate + ' of ' + name + ' | ')
    data = Buffer.alloc(size)
    for (let at = 0; at < size; at += unit.length) unit.copy(data, at)
  } else if (args.includes('mjpeg')) {
    const scale = args[args.indexOf('-vf') + 1]
    data = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(' fake jpeg ' + scale + ' of ' + name + ' '), Buffer.from([0xff, 0xd9])])
  } else {
    finish(1, 'fake ffmpeg: unknown job')
  }
  fs.writeFileSync(output, data)
  finish(0)
}, delayOf())

function delayOf () {
  for (const [part, ms] of Object.entries(control.delayFor || {})) if (args.some((a) => a.includes(part))) return ms
  return control.delayMs || 0
}
