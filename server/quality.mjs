// Quality of a file: its codec, a score to compare two versions of a song, and
// its real quality read from the spectrum.
//
// Score: lossless 1000000 + bitDepth x 1000 + sampleRate / 100; lossy kbps x a
// codec factor (mp3 1.0, aac and vorbis 1.3, opus 1.6). A lossy file whose highs
// stop well under what its bitrate keeps (an mp3 320 made from a 128) and a
// "lossless" file whose highs stop (a FLAC made from an mp3) are worth the LAME
// bitrate of that cut, as an mp3. A lossless file decoded from a lossy one
// (the null test) is worth that lossy file. A new file is better than the kept
// one when both are lossy and it beats it by more than 5%, otherwise when it is
// higher.
//
// The spectrum: ffmpeg decodes up to 60 s to mono float at 44.1 kHz, JS cuts it
// into frames of 4096 samples (Hann window, real FFT) and sums the power per bin.
// Levels are relative to the 1-8 kHz band; 40 bands of 500 Hz from 2 kHz say
// where the music stops: a band with music, a step of 6 dB right above it, then a
// floor at least 20 dB lower (flat, or very deep).

export const CODECS = ['mp3', 'aac', 'vorbis', 'opus', 'flac', 'alac', 'wav']
export const LOSSY_CODECS = ['mp3', 'aac', 'vorbis', 'opus']
const FACTOR = { mp3: 1.0, aac: 1.3, vorbis: 1.3, opus: 1.6 }
const LOSSLESS_BASE = 1000000

// The version of this analysis: a track with a lower qualityV is analysed again.
export const QUALITY_V = 2
export const QUALITY_TIMEOUT = 120000

// LAME's own lowpass per bitrate (lame.c optimum_bandwidth), kbps -> Hz.
export const LAME_LOWPASS = [
  [8, 2000], [16, 3700], [24, 3900], [32, 5500], [40, 7000], [48, 7500], [56, 10000], [64, 11000],
  [80, 13500], [96, 15100], [112, 15600], [128, 17000], [160, 17500], [192, 18600], [224, 19400],
  [256, 19700], [320, 20500]
]
// Every class a measured cutoff can give (the edge stops at 19.5 kHz: 256 at most).
export const EQUIV_KBPS = LAME_LOWPASS.map(([kbps]) => kbps).filter((kbps) => kbps <= 256)

export const SAMPLE_RATE = 44100
export const FRAME = 4096
export const MIN_FRAMES = 32
export const SILENCE_DB = -60
// 60 s of mono f32le is 10.6 MB: past this something is wrong.
export const MAX_PCM_BYTES = 12 * 1024 * 1024
export const BAND_COUNT = 40

// The cutoff rule's thresholds (dB). Exported so a test can drop each one.
export const CUTOFF = Object.freeze({ music: -60, step: 6, drop: 20, flat: 10, deep: 40 })

/** Our codec name for a parsed file (format is our AUDIO_FORMATS key). */
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

/** kbps of a lossy file: the tag, else size and duration, else null. */
export function kbpsOf (t) {
  if (typeof t.bitrate === 'number' && t.bitrate > 0) return t.bitrate / 1000
  if (typeof t.duration === 'number' && t.duration > 0 && t.size > 0) return (t.size * 8) / t.duration / 1000
  return null
}

export function scoreOf (t) {
  if (t.lossless && t.fakeLossless !== true) {
    return LOSSLESS_BASE + (t.bitDepth || 16) * 1000 + Math.round((t.sampleRate || 44100) / 100)
  }
  if (t.fakeLossless === true) return (t.equivKbps || 0) * 1.0
  if (!t.lossless && typeof t.equivKbps === 'number' && t.equivKbps > 0) return t.equivKbps * 1.0
  const kbps = kbpsOf(t)
  if (kbps === null) return 0
  return Math.round(kbps * (FACTOR[t.codec] || 1.0) * 1000) / 1000
}

/** Is a file of score `next` better than the kept one of score `kept`? */
export function isBetter (next, kept) {
  if (next < LOSSLESS_BASE && kept < LOSSLESS_BASE) return next > kept * 1.05
  return next > kept
}

/** The highest LAME bitrate whose lowpass is at most the cutoff + 300 Hz (8 when none). */
export function classKbps (cutoffHz) {
  let best = 8
  for (const [kbps, hz] of LAME_LOWPASS) if (hz <= cutoffHz + 300) best = kbps
  return best
}

/** A cutoff as stored: a multiple of 500 in 2500..19500, else null. */
export function validCutoff (v) {
  return Number.isInteger(v) && v >= 2500 && v <= 19500 && v % 500 === 0 ? v : null
}

// ------------------------------------------------------------------- FFT

/**
 * In-place radix-2 complex FFT of size n (a power of 2). inverse: e^{+i}, not
 * scaled by 1/n.
 */
export function makeFft (n) {
  const levels = Math.round(Math.log2(n))
  if (2 ** levels !== n) throw new Error('FFT size must be a power of 2')
  const rev = new Uint32Array(n)
  for (let i = 0; i < n; i++) {
    let r = 0
    for (let b = 0, x = i; b < levels; b++, x >>= 1) r = (r << 1) | (x & 1)
    rev[i] = r
  }
  const cos = new Float64Array(n / 2)
  const sin = new Float64Array(n / 2)
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n)
    sin[i] = Math.sin((2 * Math.PI * i) / n)
  }
  return function fft (re, im, inverse = false) {
    for (let i = 0; i < n; i++) {
      const j = rev[i]
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t
        t = im[i]; im[i] = im[j]; im[j] = t
      }
    }
    const sign = inverse ? 1 : -1
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1
      const step = n / size
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const c = cos[k]
          const s = sign * sin[k]
          const l = j + half
          const tre = re[l] * c - im[l] * s
          const tim = re[l] * s + im[l] * c
          re[l] = re[j] - tre
          im[l] = im[j] - tim
          re[j] += tre
          im[j] += tim
        }
      }
    }
  }
}

/**
 * The power spectrum of a real block of n samples (n a power of 2), through one
 * complex FFT of n / 2. power(x, out) ADDS |X[k]|^2 to out[k], k = 0..n/2.
 */
export function makeRealPower (n) {
  const m = n / 2
  const fft = makeFft(m)
  const re = new Float64Array(m)
  const im = new Float64Array(m)
  const wc = new Float64Array(m + 1)
  const ws = new Float64Array(m + 1)
  for (let k = 0; k <= m; k++) {
    wc[k] = Math.cos((2 * Math.PI * k) / n)
    ws[k] = Math.sin((2 * Math.PI * k) / n)
  }
  return function power (x, out) {
    for (let i = 0; i < m; i++) {
      re[i] = x[2 * i]
      im[i] = x[2 * i + 1]
    }
    fft(re, im)
    for (let k = 0; k <= m; k++) {
      const k1 = k === m ? 0 : k
      const k2 = k === 0 ? 0 : m - k
      const ar = re[k1]
      const ai = im[k1]
      const br = re[k2]
      const bi = im[k2]
      // Z = E + iO; E and O the DFTs of the even and odd samples.
      const er = (ar + br) / 2
      const ei = (ai - bi) / 2
      const or = (ai + bi) / 2
      const oi = -(ar - br) / 2
      const xr = er + wc[k] * or + ws[k] * oi
      const xi = ei + wc[k] * oi - ws[k] * or
      out[k] += xr * xr + xi * xi
    }
  }
}

// --------------------------------------------------------------- spectrum

const HANN = (() => {
  const w = new Float64Array(FRAME)
  for (let i = 0; i < FRAME; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME)
  return w
})()

// Bin k is k x 44100 / 4096 Hz. The bins of [f1, f2).
function binsOf (f1, f2) {
  const out = []
  for (let k = 0; k <= FRAME / 2; k++) {
    const f = (k * SAMPLE_RATE) / FRAME
    if (f >= f1 && f < f2) out.push(k)
  }
  return out
}
const REF_BINS = binsOf(1000, 8000)
const BAND_BINS = Array.from({ length: BAND_COUNT }, (_, j) => binsOf(2000 + 500 * j, 2500 + 500 * j))

/**
 * Power per bin, summed over consecutive frames of 4096 mono float samples (a
 * partial last frame is dropped). push() takes f32le bytes in any chunking.
 */
export class Spectrum {
  constructor () {
    this.power = new Float64Array(FRAME / 2 + 1)
    this.frames = 0
    this.sumSq = 0
    this._frame = new Float64Array(FRAME)
    this._windowed = new Float64Array(FRAME)
    this._fill = 0
    this._rest = null
    this._fft = makeRealPower(FRAME)
  }

  push (chunk) {
    let b = chunk
    if (this._rest !== null) {
      b = Buffer.concat([this._rest, chunk])
      this._rest = null
    }
    const whole = b.length - (b.length % 4)
    for (let off = 0; off < whole; off += 4) {
      this._frame[this._fill++] = b.readFloatLE(off)
      if (this._fill === FRAME) {
        this._take()
        this._fill = 0
      }
    }
    if (whole < b.length) this._rest = Buffer.from(b.subarray(whole))
  }

  /** Float samples straight in (tests). */
  pushSamples (samples) {
    for (let i = 0; i < samples.length; i++) {
      this._frame[this._fill++] = samples[i]
      if (this._fill === FRAME) {
        this._take()
        this._fill = 0
      }
    }
  }

  _take () {
    const x = this._frame
    const w = this._windowed
    let sq = 0
    for (let i = 0; i < FRAME; i++) {
      sq += x[i] * x[i]
      w[i] = x[i] * HANN[i]
    }
    this.sumSq += sq
    this._fft(w, this.power)
    this.frames++
  }

  /** RMS of the analysed samples, dBFS (-Infinity for silence). */
  rmsDb () {
    const n = this.frames * FRAME
    return n === 0 ? -Infinity : 20 * Math.log10(Math.sqrt(this.sumSq / n))
  }

  band (bins) {
    let s = 0
    for (const k of bins) s += this.power[k]
    return s
  }

  /**
   * { ref, C } with C[0..39] the 500 Hz bands from 2 kHz in dB under REF (floored
   * at -200), or null when inconclusive (too short, silent, nothing in REF).
   */
  levels () {
    if (this.frames < MIN_FRAMES) return null
    const ref = this.band(REF_BINS)
    if (!(ref > 0)) return null
    if (!(this.rmsDb() >= SILENCE_DB)) return null
    const C = BAND_BINS.map((bins) => {
      const b = this.band(bins)
      return b > 0 ? Math.max(-200, 10 * Math.log10(b / ref)) : -200
    })
    return { ref, C }
  }
}

/**
 * Where the music stops: the upper edge (Hz) of the highest band j (34 down to 0)
 * that holds music, has a step right above it and a floor (the bands from j + 3)
 * well under it; null when no band does (no cut up to 19.5 kHz).
 */
export function cutoffOf (C, t = CUTOFF) {
  for (let j = 34; j >= 0; j--) {
    if (C[j] < t.music) continue
    if (C[j + 1] > C[j] - t.step) continue
    const floor = C.slice(j + 3, BAND_COUNT)
    const max = Math.max(...floor)
    const min = Math.min(...floor)
    const drop = C[j] - max
    if (drop >= t.drop && (max - min <= t.flat || max <= C[j] - t.deep)) return 2000 + 500 * (j + 1)
  }
  return null
}

// ---------------------------------------------------------------- ffmpeg

/** The decode of the analysis: up to 60 s (from second 30 of a track of 90 s or more). */
export function spectrumArgs (file, duration) {
  const args = ['-nostdin', '-hide_banner', '-v', 'error']
  if (typeof duration === 'number' && duration >= 90) args.push('-ss', '30')
  args.push('-t', '60', '-i', file, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', '-acodec', 'pcm_f32le', 'pipe:1')
  return args
}

/**
 * Analyse a file with ffmpeg (a runner with stream()). Resolves { cutoffHz } or
 * null when inconclusive (ffmpeg failed or timed out, too short, silent).
 */
export async function measureQuality (runner, file, duration, signal = null) {
  const spectrum = new Spectrum()
  try {
    await runner.stream(spectrumArgs(file, duration), (chunk) => spectrum.push(chunk), { timeoutMs: QUALITY_TIMEOUT, maxBytes: MAX_PCM_BYTES, quiet: true, signal })
  } catch {
    return null
  }
  const levels = spectrum.levels()
  if (levels === null) return null
  return { cutoffHz: cutoffOf(levels.C) }
}

// -------------------------------------------------------------- verdicts

/**
 * The quality fields of a track from a measurement (null: inconclusive):
 * cutoffHz, equivKbps, fakeLossless, qualityV and the score that follows.
 * Changes and returns `t`.
 */
export function applyQuality (t, measured) {
  const cutoffHz = measured === null ? null : validCutoff(measured.cutoffHz)
  t.cutoffHz = cutoffHz
  if (t.lossless) {
    t.fakeLossless = measured === null ? null : cutoffHz !== null
    t.equivKbps = t.fakeLossless === true ? classKbps(cutoffHz) : null
  } else {
    const kbps = kbpsOf(t)
    const cls = cutoffHz === null ? null : classKbps(cutoffHz)
    t.equivKbps = cls !== null && kbps !== null && cls <= 0.8 * kbps ? cls : null
    t.fakeLossless = null
  }
  t.qualityV = QUALITY_V
  t.score = scoreOf(t)
  return t
}

/** A lossless file under 44.1 kHz is not analysed: it only gets its version. */
export function skipsAnalysis (t) {
  return t.lossless === true && typeof t.sampleRate === 'number' && t.sampleRate < 44100
}

/** Has this track still to be analysed (by this version of the analysis)? */
export function wantsQualityCheck (t) {
  return !(Number.isInteger(t.qualityV) && t.qualityV >= QUALITY_V)
}

/** The fields of a track that has not been analysed. */
export function unanalysed (t) {
  t.cutoffHz = null
  t.equivKbps = null
  t.fakeLossless = null
  t.qualityV = 0
  return t
}

// -------------------------------------------------------------- null test
//
// A lossless file decoded from a lossy one holds the same samples: decode both
// over the same 30 s and subtract. Both are clamped to [-1, 1] (a FLAC of 16 or
// 24 bits cannot hold the overshoots a lossy decoder makes), aligned within 4096
// samples (a decoder that did not drop the encoder delay), and the residual is
// compared with the lossy file's own level.

export const NULL_SECONDS = 30
export const NULL_DB = -60
export const NULL_MAX_LAG = 4096
export const NULL_TIMEOUT = 120000
const NULL_MAX_BYTES = 12 * 1024 * 1024 // 30 s of stereo f32le is 10.6 MB

/** The decode of the null test: 30 s of stereo float at 44.1 kHz from `start`, decoded from the start. */
export function nullArgs (file, start) {
  return ['-nostdin', '-hide_banner', '-v', 'error', '-i', file, '-map', '0:a:0', '-vn', '-ss', String(start), '-t', String(NULL_SECONDS),
    '-ac', '2', '-ar', String(SAMPLE_RATE), '-f', 'f32le', '-acodec', 'pcm_f32le', 'pipe:1']
}

/** Where both decodes start: second 30 when both tracks last 75 s or more, else 0. */
export function nullStart (durations) {
  return durations.every((d) => typeof d === 'number' && d >= 75) ? 30 : 0
}

/**
 * The decode of the null test as interleaved stereo floats (whole frames only),
 * read straight into one array of 30 s as the output comes: no chunk is kept.
 */
export async function decodeStereo (runner, file, start) {
  const out = new Float32Array(NULL_SECONDS * SAMPLE_RATE * 2)
  let n = 0
  let rest = null
  await runner.stream(nullArgs(file, start), (chunk) => {
    let b = chunk
    if (rest !== null) {
      b = Buffer.concat([rest, chunk])
      rest = null
    }
    const whole = b.length - (b.length % 4)
    for (let off = 0; off < whole && n < out.length; off += 4) out[n++] = b.readFloatLE(off)
    if (whole < b.length) rest = Buffer.from(b.subarray(whole))
  }, { timeoutMs: NULL_TIMEOUT, maxBytes: NULL_MAX_BYTES, quiet: true })
  return out.subarray(0, n - (n % 2))
}

const clamp = (v) => (v > 1 ? 1 : v < -1 ? -1 : v)

// The lag (samples of b behind a, -max..max) with the highest correlation of the
// two mono sums, over a window in the middle.
export function bestLag (a, b, max) {
  const frames = Math.min(a.length, b.length) / 2
  const w = 32768
  if (frames < w + 2 * max) return 0
  const size = 65536
  const fft = makeFft(size)
  const start = Math.floor((frames - w) / 2)
  const are = new Float64Array(size)
  const aim = new Float64Array(size)
  const bre = new Float64Array(size)
  const bim = new Float64Array(size)
  for (let i = 0; i < w; i++) are[i] = a[2 * (start + i)] + a[2 * (start + i) + 1]
  for (let j = 0; j < w + 2 * max; j++) {
    const f = start - max + j
    bre[j] = b[2 * f] + b[2 * f + 1]
  }
  fft(are, aim)
  fft(bre, bim)
  // conj(A) x B: corr[m] = sum a[i] b[i + m]
  for (let k = 0; k < size; k++) {
    const r = are[k] * bre[k] + aim[k] * bim[k]
    const i = are[k] * bim[k] - aim[k] * bre[k]
    are[k] = r
    aim[k] = i
  }
  fft(are, aim, true)
  let best = 0
  let bestValue = -Infinity
  for (let m = 0; m <= 2 * max; m++) {
    if (are[m] > bestValue) {
      bestValue = are[m]
      best = m - max
    }
  }
  // Silence (or no likeness at all): no lag to speak of.
  return bestValue > 0 ? best : 0
}

/**
 * The residual of b against a (interleaved stereo, both clamped to [-1, 1]) at a
 * lag, in dB under a's level; null when a is silent or the overlap shorter than 1 s.
 */
export function residualDb (a, b, lag) {
  const frames = Math.min(a.length, b.length) / 2
  let sig = 0
  let err = 0
  let n = 0
  for (let i = Math.max(0, -lag); i < frames && i + lag < frames; i++) {
    const j = i + lag
    for (let c = 0; c < 2; c++) {
      const x = clamp(a[2 * i + c])
      const d = x - clamp(b[2 * j + c])
      sig += x * x
      err += d * d
    }
    n++
  }
  if (n < SAMPLE_RATE) return null
  if (!(10 * Math.log10(sig / (2 * n)) >= SILENCE_DB)) return null
  return err === 0 ? -200 : 10 * Math.log10(err / sig)
}

/** The best residual (dB) of b against a: at lag 0, or at the best correlated lag. */
export function nullResidual (a, b, maxLag = NULL_MAX_LAG) {
  return residualAt(a, b, bestLag(a, b, maxLag))
}

/** The residual (dB) of b against a at lag 0 or at `lag`, the lower. */
export function residualAt (a, b, lag) {
  const at0 = residualDb(a, b, 0)
  if (at0 === null) return null
  const atLag = lag === 0 ? at0 : residualDb(a, b, lag)
  return atLag === null ? at0 : Math.min(at0, atLag)
}

/**
 * Was the lossless file made by decoding that very lossy file (or does it hold
 * the samples of that decode)? true, false, or null when it cannot tell (a
 * decode failed, silence, too short).
 */
export async function nullTest (runner, lossy, lossless) {
  const start = nullStart([lossy.duration, lossless.duration])
  try {
    const a = await decodeStereo(runner, lossy.file, start)
    const b = await decodeStereo(runner, lossless.file, start)
    const r = nullResidual(a, b)
    return r === null ? null : r <= NULL_DB
  } catch {
    return null
  }
}

// ------------------------------------------------------------ one version
//
// Matching fingerprints say "the same song", not "the same version": an
// instrumental, a karaoke or another mix keeps the chords the fingerprint hears.
// Copies of one version keep the spectrum where the voice sits, and another
// version does not, at least where the voice sings. So both files are decoded
// whole (mono, 11025 Hz: the band ends at 5 kHz), aligned, cut in frames, and
// each frame's energy in 24 bands between 150 Hz and 5 kHz is set against the
// first file's, after one gain for the whole pair. The song is judged in spans
// of 10 s: any span clearly apart makes two versions, every span close makes
// one, and anything between tells nothing (both files stay). Each frame's
// difference counts against the weaker of the two frames, so it reads the same
// whichever file comes first. Measured on real files, both ways round: copies
// of one version stay at -10 dB or lower in every span down to AAC 64, Opus 32
// and MP3 64, inverted, louder, mono, 0.5 s late or with a silence; a mix
// against its instrumental reaches +1 to +4 dB where the voice sings, also when
// it only comes in after 1:40; an MP3 at 32 kbps falls between.

export const VERSION_RATE = 11025
export const VERSION_FRAME = 1024
const VERSION_HOP = 512
const VERSION_BANDS = 24
const VERSION_LOW = 150
const VERSION_HIGH = 5000
export const VERSION_SPAN_S = 10
const VERSION_EDGE_S = 2 // the first and last seconds of the overlap are left out (encoder delay, fades)
const VERSION_RANGE_DB = 50 // frames this far under the loudest one are left out
const VERSION_MIN_FRAMES = 40 // in a span, to judge it
export const VERSION_MAX_S = 20 * 60 // at most this much of a track is compared
export const VERSION_SAME_DB = -9
export const VERSION_APART_DB = -3
const VERSION_TIMEOUT = 300000
const LAG_SECONDS = 12 // the probes that align the two files
const LAG_MAX = Math.round(0.3 * VERSION_RATE)

let bandWindow = null
let bandOf = null

function bandSetup () {
  if (bandWindow !== null) return
  const N = VERSION_FRAME
  bandWindow = new Float64Array(N)
  for (let i = 0; i < N; i++) bandWindow[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N)
  // The band of each FFT bin, -1 outside 150 Hz - 5 kHz; the bands are log-spaced.
  bandOf = new Int8Array(N / 2).fill(-1)
  const ratio = VERSION_HIGH / VERSION_LOW
  for (let k = 1; k < N / 2; k++) {
    const f = (k * VERSION_RATE) / N
    if (f < VERSION_LOW || f >= VERSION_HIGH) continue
    bandOf[k] = Math.min(VERSION_BANDS - 1, Math.floor((VERSION_BANDS * Math.log(f / VERSION_LOW)) / Math.log(ratio)))
  }
}

/** The decode of the version check: mono floats at 11025 Hz, from `start`, at most `seconds`. */
export function versionArgs (file, start = 0, seconds = VERSION_MAX_S) {
  return ['-nostdin', '-hide_banner', '-v', 'error', '-ss', String(start), '-t', String(seconds), '-i', file, '-map', '0:a:0', '-vn',
    '-ac', '1', '-ar', String(VERSION_RATE), '-f', 'f32le', '-acodec', 'pcm_f32le', 'pipe:1']
}

/**
 * The band energies of a mono stream, frame by frame, from sample `skip` on (a
 * negative `skip` puts that many zeros first): push() the f32le output as it
 * comes, then frames() gives one Float32Array of 24 values per frame.
 */
export class BandFrames {
  constructor (skip = 0) {
    bandSetup()
    this.skip = Math.max(0, skip)
    this.buf = new Float64Array(VERSION_FRAME)
    this.fill = Math.max(0, -skip) // zeros already in place
    this.rest = null
    this.data = new Float32Array(1024 * VERSION_BANDS)
    this.count = 0
    this.limit = Math.ceil((VERSION_MAX_S * VERSION_RATE) / VERSION_HOP)
    this.fft = makeFft(VERSION_FRAME)
    this.re = new Float64Array(VERSION_FRAME)
    this.im = new Float64Array(VERSION_FRAME)
  }

  push (chunk) {
    let b = chunk
    if (this.rest !== null) {
      b = Buffer.concat([this.rest, chunk])
      this.rest = null
    }
    const whole = b.length - (b.length % 4)
    for (let off = 0; off < whole; off += 4) {
      if (this.skip > 0) {
        this.skip--
        continue
      }
      if (this.fill >= VERSION_FRAME) this._frame()
      this.buf[this.fill++] = b.readFloatLE(off)
    }
    if (whole < b.length) this.rest = Buffer.from(b.subarray(whole))
  }

  _frame () {
    if (this.count < this.limit) {
      const N = VERSION_FRAME
      const { re, im, buf } = this
      for (let i = 0; i < N; i++) {
        const v = buf[i]
        re[i] = (v > 1 ? 1 : v < -1 ? -1 : v) * bandWindow[i]
        im[i] = 0
      }
      this.fft(re, im)
      if ((this.count + 1) * VERSION_BANDS > this.data.length) {
        const more = new Float32Array(this.data.length * 2)
        more.set(this.data)
        this.data = more
      }
      const at = this.count * VERSION_BANDS
      for (let k = 1; k < N / 2; k++) {
        const band = bandOf[k]
        if (band >= 0) this.data[at + band] += re[k] * re[k] + im[k] * im[k]
      }
      this.count++
    }
    // Keep the second half: the next frame starts one hop later.
    this.buf.copyWithin(0, VERSION_HOP, VERSION_FRAME)
    this.fill = VERSION_FRAME - VERSION_HOP
  }

  /** { data, count }: frame f's band b at data[f * 24 + b]. */
  frames () {
    if (this.fill >= VERSION_FRAME) this._frame()
    return { data: this.data, count: this.count }
  }
}

/**
 * How far b is from being the version a is, span by span (both frames() of
 * BandFrames, aligned): the 90th percentile of each span's frames, in dB under
 * a's level. null for a span that cannot tell (too few loud frames).
 */
export function spanDistances (fa, fb) {
  const edge = Math.round((VERSION_EDGE_S * VERSION_RATE) / VERSION_HOP)
  const span = Math.round((VERSION_SPAN_S * VERSION_RATE) / VERSION_HOP)
  const A = fa.data
  const B = fb.data
  const from = edge
  const to = Math.min(fa.count, fb.count) - edge
  if (to - from < VERSION_MIN_FRAMES) return []
  // One gain for the pair, on band amplitudes.
  let ab = 0
  let aa = 0
  let bb = 0
  for (let k = from * VERSION_BANDS, end = to * VERSION_BANDS; k < end; k++) {
    const x = Math.sqrt(A[k])
    const y = Math.sqrt(B[k])
    ab += x * y
    aa += x * x
    bb += y * y
  }
  if (!(aa > 0) || !(bb > 0)) return []
  const g = ab / bb
  // Each frame's difference against the weaker of the two: what one version has
  // and the other lacks counts the same both ways round.
  const sums = new Float64Array(3 * (to - from))
  let loudest = 0
  for (let f = from; f < to; f++) {
    let sa = 0
    let sb = 0
    let e2 = 0
    for (let k = f * VERSION_BANDS, end = k + VERSION_BANDS; k < end; k++) {
      const x = Math.sqrt(A[k])
      const y = g * Math.sqrt(B[k])
      sa += x * x
      sb += y * y
      e2 += (x - y) * (x - y)
    }
    const i = 3 * (f - from)
    sums[i] = Math.max(sa, sb)
    sums[i + 1] = Math.min(sa, sb)
    sums[i + 2] = e2
    if (sums[i] > loudest) loudest = sums[i]
  }
  const floor = loudest * 10 ** (-VERSION_RANGE_DB / 10)
  const out = []
  for (let start = from; start < to; start += span) {
    const end = Math.min(to, start + span)
    const ratios = []
    for (let f = start; f < end; f++) {
      const i = 3 * (f - from)
      if (!(sums[i] > 0) || sums[i] < floor) continue
      ratios.push(sums[i + 1] > 0 ? sums[i + 2] / sums[i + 1] : 1e6)
    }
    if (ratios.length < VERSION_MIN_FRAMES) {
      out.push(null)
      continue
    }
    ratios.sort((x, y) => x - y)
    const r = ratios[Math.min(ratios.length - 1, Math.floor(0.9 * ratios.length))]
    out.push(r === 0 ? -200 : 10 * Math.log10(r))
  }
  return out
}

/** One version (true), two (false) or cannot tell (null), from the spans' distances. */
export function versionVerdict (spans) {
  const judged = spans.filter((d) => d !== null)
  if (judged.length === 0) return null
  if (judged.some((d) => d >= VERSION_APART_DB)) return false
  if (judged.every((d) => d <= VERSION_SAME_DB)) return true
  return null
}

/** Mono floats at 11025 Hz, `seconds` of them from `start`. */
async function decodeMono (runner, file, start, seconds) {
  const out = new Float32Array(Math.ceil(seconds * VERSION_RATE))
  let n = 0
  let rest = null
  await runner.stream(versionArgs(file, start, seconds), (chunk) => {
    let b = chunk
    if (rest !== null) {
      b = Buffer.concat([rest, chunk])
      rest = null
    }
    const whole = b.length - (b.length % 4)
    for (let off = 0; off < whole && n < out.length; off += 4) out[n++] = b.readFloatLE(off)
    if (whole < b.length) rest = Buffer.from(b.subarray(whole))
  }, { timeoutMs: VERSION_TIMEOUT, quiet: true })
  return out.subarray(0, n)
}

/**
 * The lag (samples, -max..max) where b best follows a: the strongest correlation
 * of a's middle stretch with b, either sign (a copy may be inverted). null when a
 * is silent there or too short.
 */
export function monoLag (a, b, max) {
  const w = 16384
  if (a.length < w + 2 * max || b.length < w + 2 * max) return null
  const start = Math.floor((Math.min(a.length, b.length) - w) / 2)
  let power = 0
  for (let i = 0; i < w; i++) power += a[start + i] * a[start + i]
  if (!(10 * Math.log10(power / w) >= SILENCE_DB)) return null
  const size = 65536
  const fft = makeFft(size)
  const are = new Float64Array(size)
  const aim = new Float64Array(size)
  const bre = new Float64Array(size)
  const bim = new Float64Array(size)
  for (let i = 0; i < w; i++) are[i] = a[start + i]
  for (let j = 0; j < w + 2 * max; j++) bre[j] = b[start - max + j]
  fft(are, aim)
  fft(bre, bim)
  for (let k = 0; k < size; k++) {
    const r = are[k] * bre[k] + aim[k] * bim[k]
    const i = are[k] * bim[k] - aim[k] * bre[k]
    are[k] = r
    aim[k] = i
  }
  fft(are, aim, true)
  let best = null
  let bestValue = 0
  for (let m = 0; m <= 2 * max; m++) {
    const v = Math.abs(are[m])
    if (v > bestValue) {
      bestValue = v
      best = m - max
    }
  }
  return best
}

/**
 * Where b sounds like a, in samples at 11025 Hz (b at i + offset is a at i):
 * the fingerprints' `shift` (seconds) refined on a short stretch, tried at a few
 * places in the track until one is not silent; the bare shift when none helps.
 */
export async function versionOffset (runner, a, b, shift = 0) {
  const coarse = Math.round(shift * VERSION_RATE)
  const length = Math.min(a.duration || 0, b.duration || 0)
  const places = length > LAG_SECONDS * 2 ? [0.5, 0.3, 0.7, 0.15, 0.85].map((p) => p * (length - LAG_SECONDS)) : [0]
  for (const at of places) {
    const aStart = Math.max(0, at, -shift)
    const da = await decodeMono(runner, a.file, aStart, LAG_SECONDS)
    const db = await decodeMono(runner, b.file, Math.max(0, aStart + shift), LAG_SECONDS)
    // The two stretches start where the shift says they sound alike.
    const lag = monoLag(da, db, LAG_MAX)
    if (lag !== null) return coarse + lag
  }
  return coarse
}

/** The band frames of a whole file, `skip` samples dropped first (or zeros put first). */
async function bandFramesOf (runner, file, skip) {
  const bands = new BandFrames(skip)
  await runner.stream(versionArgs(file), (chunk) => bands.push(chunk), { timeoutMs: VERSION_TIMEOUT, quiet: true })
  return bands.frames()
}

/** One version (true), two (false), or cannot tell (null): the whole of both files. */
export async function sameVersion (runner, a, b, shift = 0) {
  try {
    const offset = await versionOffset(runner, a, b, shift)
    // b at i + offset is a at i: drop b's first `offset` samples, or a's first -offset.
    const fa = await bandFramesOf(runner, a.file, Math.max(0, -offset))
    const fb = await bandFramesOf(runner, b.file, Math.max(0, offset))
    return versionVerdict(spanDistances(fa, fb))
  } catch {
    return null
  }
}

/**
 * Two files of one song: { sameVersion, decoded }, each true, false or null
 * (cannot tell). b at t + shift (seconds) sounds like a at t. `decoded`, only
 * when exactly one file is lossless: does it hold the samples of the lossy one?
 */
export async function compareFiles (runner, a, b, shift = 0) {
  const out = { sameVersion: await sameVersion(runner, a, b, shift), decoded: null }
  if (a.lossless !== b.lossless && out.sameVersion === true) {
    try {
      const start = nullStart([a.duration, b.duration])
      const da = await decodeStereo(runner, a.file, start + Math.max(0, -shift))
      const db = await decodeStereo(runner, b.file, start + Math.max(0, shift))
      const lag = bestLag(da, db, NULL_MAX_LAG)
      const r = a.lossless ? residualAt(db, da, -lag) : residualAt(da, db, lag)
      out.decoded = r === null ? null : r <= NULL_DB
    } catch {}
  }
  return out
}
