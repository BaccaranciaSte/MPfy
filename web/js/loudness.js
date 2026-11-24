// Loudness: how loud a song is, from its tags (ReplayGain 2, the R128 gains of Opus) or measured
// by the source (EBU R128, jobs.mjs), and the volume that plays it at the target.
//
// A song's loudness is { lufs, peak, album, from }: its integrated loudness in LUFS, its sample
// peak in dBFS (null when unknown), its album's loudness in LUFS (null when unknown) and where it
// came from ('tag' or 'scan'). ReplayGain gains are against -18 LUFS, R128 gains (Q7.8 dB) against
// -23 LUFS. Portable: the source, the phone's core and the page use it alike.

/** The loudness every song plays at (the usual level of the streaming services). */
export const TARGET_LUFS = -14

const fin = (v) => typeof v === 'number' && Number.isFinite(v)
const round = (v) => Math.round(v * 100) / 100
const inLufs = (v) => fin(v) && v >= -70 && v <= 3
const inPeak = (v) => fin(v) && v >= -80 && v <= 12

function peakDb (ratio) {
  if (!fin(ratio) || ratio <= 0) return null
  const db = 20 * Math.log10(ratio)
  return inPeak(db) ? round(db) : null
}

function lufsOf (gainDb, r128) {
  if (fin(gainDb)) return round(-18 - gainDb)
  if (Number.isInteger(r128)) return round(-23 - r128 / 256)
  return null
}

/**
 * The loudness the tags give: { trackGain, trackPeak, albumGain, albumPeak } (dB, ratio) and
 * { r128Track, r128Album } (Q7.8), any of them missing. Null without a track gain.
 */
export function loudFromTags (raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const lufs = lufsOf(r.trackGain, r.r128Track)
  if (!inLufs(lufs)) return null
  const album = lufsOf(r.albumGain, r.r128Album)
  return { lufs, peak: peakDb(r.trackPeak), album: inLufs(album) ? album : null, from: 'tag' }
}

/** The loudness the source measured: null when the numbers make no sense. */
export function loudFromScan (lufs, peak) {
  if (!inLufs(lufs)) return null
  return { lufs: round(lufs), peak: inPeak(peak) ? round(peak) : null, album: null, from: 'scan' }
}

/** A stored loudness as it should be, or null. */
export function validLoud (l) {
  if (!l || typeof l !== 'object' || !inLufs(l.lufs) || (l.from !== 'tag' && l.from !== 'scan')) return null
  return { lufs: round(l.lufs), peak: inPeak(l.peak) ? round(l.peak) : null, album: inLufs(l.album) ? round(l.album) : null, from: l.from }
}

/**
 * The volume (0..1) that plays a song at the target: only ever down (a player's volume stops at
 * 1, and nothing louder can clip). 1 for a song with no loudness.
 */
export function gainOf (loud, { album = false } = {}) {
  const l = validLoud(loud)
  if (l === null) return 1
  const lufs = album && l.album !== null ? l.album : l.lufs
  const db = Math.min(0, TARGET_LUFS - lufs)
  return Math.round(10 ** (db / 20) * 10000) / 10000
}
