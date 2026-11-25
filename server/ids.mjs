// Identifier validation. Every id that reaches a file path is checked here against a
// strict regex first, and paths are always built from validated ids plus fixed
// extensions: no string coming from a request is ever joined into a path.

export const TRACK_ID_RE = /^[0-9a-f]{24}$/
export const COVER_ID_RE = /^[0-9a-f]{24}$/
export const PLAYLIST_ID_RE = /^[0-9a-f]{16}$/
export const PUBLIC_KEY_RE = /^[0-9a-f]{64}$/
export const PROFILE_ID_RE = /^[0-9a-f]{32}$/
// Upload sessions, pending uploads and archives: 16 hex.
export const JOB_ID_RE = /^[0-9a-f]{16}$/
// albumId and artistId are computed by the client: opaque hex ids here.
export const ALBUM_ID_RE = /^[0-9a-f]{8,32}$/

export function isTrackId (s) {
  return typeof s === 'string' && TRACK_ID_RE.test(s)
}

export function isCoverId (s) {
  return typeof s === 'string' && COVER_ID_RE.test(s)
}

export function isPlaylistId (s) {
  return typeof s === 'string' && PLAYLIST_ID_RE.test(s)
}

export function isPublicKey (s) {
  return typeof s === 'string' && PUBLIC_KEY_RE.test(s)
}

export function isProfileId (s) {
  return typeof s === 'string' && PROFILE_ID_RE.test(s)
}

export function isJobId (s) {
  return typeof s === 'string' && JOB_ID_RE.test(s)
}

export function isAlbumId (s) {
  return typeof s === 'string' && ALBUM_ID_RE.test(s)
}

// Custom covers (PUT /api/cover-for/:kind/:id): which ids each kind takes.
export const COVER_KINDS = {
  track: isTrackId,
  album: isAlbumId,
  playlist: isPlaylistId
}
export const COVER_SIZES = ['small', 'large']
// The sizes a cover can be asked in (GET ?size=): also xl, for the Now Playing cover, which on a
// phone is about 1100 px wide. Made only when asked; a custom cover has none and comes as it is.
export const COVER_ASK_SIZES = ['small', 'large', 'xl']
// Pixel size of the JPEG versions the server makes of embedded covers.
export const COVER_PIXELS = { small: 160, large: 640, xl: 1280 }

// Audio quality levels: Opus bitrates in kbps; max is the original.
export const LEVELS = { low: 48, normal: 96, high: 160 }
export const LEVEL_NAMES = ['low', 'normal', 'high'] // ascending
export const QUALITY_NAMES = ['low', 'normal', 'high', 'max']

// Audio formats we accept, with the extension used on disk and the MIME type served.
export const AUDIO_FORMATS = {
  mp3: { ext: 'mp3', mime: 'audio/mpeg' },
  aac: { ext: 'aac', mime: 'audio/aac' },
  m4a: { ext: 'm4a', mime: 'audio/mp4' },
  flac: { ext: 'flac', mime: 'audio/flac' },
  ogg: { ext: 'ogg', mime: 'audio/ogg' },
  opus: { ext: 'opus', mime: 'audio/ogg' },
  wav: { ext: 'wav', mime: 'audio/wav' }
}

export const COVER_EXTS = ['jpg', 'png', 'webp']
export const COVER_MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }

// library/<trackId>.<ext>
export const LIBRARY_FILE_RE = /^([0-9a-f]{24})\.(mp3|aac|m4a|flac|ogg|opus|wav)$/
// covers/<coverId>.<ext>
export const COVER_FILE_RE = /^([0-9a-f]{24})\.(jpg|png|webp)$/
// covers/<coverId>.small.jpg, .large.jpg, .xl.jpg (made by ffmpeg)
export const COVER_SIZED_RE = /^([0-9a-f]{24})\.(small|large|xl)\.jpg$/
// transcodes/<trackId>.<level>.opus
export const TRANSCODE_FILE_RE = /^([0-9a-f]{24})\.(low|normal|high)\.opus$/

// fingerprints/<fileHash>.fp
export const FINGERPRINT_FILE_RE = /^([0-9a-f]{24})\.fp$/

/**
 * albumId exactly as the web computes it: FNV-1a 64 over the UTF-8 of
 * albumArtist + NUL + album, 16 hex.
 */
export function albumIdOf (track) {
  const albumArtist = track.albumArtist || track.artist || ''
  let h = 0xcbf29ce484222325n
  for (const b of Buffer.from(albumArtist + '\u0000' + (track.album || ''), 'utf8')) {
    h ^= BigInt(b)
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return h.toString(16).padStart(16, '0')
}

export function trackFileName (track) {
  if (!isTrackId(track.id)) throw new Error('invalid track id')
  const fmt = AUDIO_FORMATS[track.format]
  if (!fmt) throw new Error('invalid track format')
  return track.id + '.' + fmt.ext
}

/**
 * The name the client sent in PUT /api/upload/:filename, reduced to something safe
 * to show as a fallback title: last path component, no control characters, capped.
 * It is never used to build a path.
 */
export function cleanUploadName (raw) {
  let name = String(raw || '')
  name = name.split(/[\\/]/).pop()
  // Drop C0/C1 control characters and the Unicode bidi overrides.
  name = name.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')
  name = name.trim().slice(0, 255)
  return name
}

/** "Song name.mp3" -> "Song name"; an empty result falls back to `fallback`. */
export function titleFromFileName (name, fallback) {
  const dot = name.lastIndexOf('.')
  const base = (dot > 0 ? name.slice(0, dot) : name).trim()
  return base || fallback
}
