// Audio detection, tag reading and cover extraction.
//
// An upload is accepted only if (1) its first bytes look like one of the allowed
// containers and (2) music-metadata parses it as that kind of audio. The file name
// the client sent is never trusted for the type.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { parseFile, selectCover } from 'music-metadata'
import { AUDIO_FORMATS, COVER_MIME } from './ids.mjs'
import { codecOf } from './quality.mjs'
import { writeAtomicSync } from './util.mjs'
import { splitGenres } from '../web/js/genres.js'
import { loudFromTags } from '../web/js/loudness.js'

export const HEAD_BYTES = 4096
export const MAX_COVER_BYTES = 16 * 1024 * 1024

export const UNKNOWN_ARTIST = 'Artista sconosciuto'
export const UNKNOWN_ALBUM = 'Album sconosciuto'

function ascii (buf, start, len) {
  return buf.subarray(start, start + len).toString('latin1')
}

function isMpegAudioFrame (b, i) {
  if (b.length < i + 3 || b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return false
  const version = (b[i + 1] >> 3) & 3
  const layer = (b[i + 1] >> 1) & 3
  const bitrate = b[i + 2] >> 4
  const sampleRate = (b[i + 2] >> 2) & 3
  return version !== 1 && layer !== 0 && bitrate !== 15 && sampleRate !== 3
}

function isAdtsFrame (b, i) {
  if (b.length < i + 3 || b[i] !== 0xff || (b[i + 1] & 0xf6) !== 0xf0) return false
  return ((b[i + 2] >> 2) & 0x0f) < 13
}

/**
 * Look at the first bytes of a file and say which allowed container it could be.
 * @param {Buffer} head  the first HEAD_BYTES bytes (or fewer for tiny files)
 * @returns {'id3'|'mp3'|'aac'|'m4a'|'flac'|'ogg'|'opus'|'wav'|null}
 *   'id3' means an ID3v2 tag comes first: MP3 almost always, the parser decides.
 */
export function sniffAudio (head) {
  if (!head || head.length < 4) return null
  if (ascii(head, 0, 3) === 'ID3') return 'id3'
  if (ascii(head, 0, 4) === 'fLaC') return 'flac'
  if (ascii(head, 0, 4) === 'OggS') return head.indexOf('OpusHead', 0, 'latin1') !== -1 ? 'opus' : 'ogg'
  if (head.length >= 12 && ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WAVE') return 'wav'
  if (head.length >= 8 && ascii(head, 4, 4) === 'ftyp') return 'm4a'
  // Raw MPEG audio or ADTS, possibly after some zero padding.
  let i = 0
  while (i < head.length && head[i] === 0) i++
  if (isAdtsFrame(head, i)) return 'aac'
  if (isMpegAudioFrame(head, i)) return 'mp3'
  return null
}

/** Map music-metadata's container/codec to our format key, or null if not allowed. */
export function formatFromParsed (format, sniffed) {
  const container = String(format.container || '')
  const codec = String(format.codec || '').toLowerCase()
  if (container === 'MPEG') return 'mp3'
  if (container.startsWith('ADTS')) return 'aac'
  if (container === 'FLAC') return 'flac'
  if (container === 'WAVE') return 'wav'
  if (container === 'Ogg') {
    if (codec.includes('theora')) return null
    return codec.includes('opus') ? 'opus' : 'ogg'
  }
  // MP4 family: the container is the list of ftyp brands ("M4A/mp42/isom").
  if (sniffed === 'm4a' && codec && format.hasVideo !== true) return 'm4a'
  return null
}

/**
 * Parse an audio file. Throws when music-metadata cannot read it.
 * @param {object} [opts]
 * @param {boolean} [opts.covers=true]    read embedded pictures
 * @param {boolean} [opts.duration=true]  exact duration: for an MP3 without a
 *   Xing/Info header that means reading every frame of the file. false stops after
 *   a few frames and estimates from the size (the library rescan at startup, which
 *   must not read whole files on the phone while the API waits for it).
 * @returns {Promise<{ format: string|null, metadata: object }>}
 */
export async function readAudio (file, sniffed, { covers = true, duration = true } = {}) {
  const metadata = await parseFile(file, { duration: duration !== false, skipCovers: !covers })
  return { format: formatFromParsed(metadata.format, sniffed), metadata }
}

// Shorter than this is not a song.
export const MIN_DURATION = 0.5

/**
 * Is the parsed duration long enough to be a song? Formats found by scanning for
 * frame sync words (MPEG audio, ADTS) always get a duration from that scan when it
 * finds frames, so a missing one is refused too. Containers with a real header
 * (FLAC, Ogg, WAVE, MP4) are refused when they declare less, and accepted when
 * they declare nothing (a FLAC whose encoder did not know the total length).
 * Call it on a parse made with { duration: true }.
 *
 * This alone does NOT tell noise from MPEG audio: music-metadata resyncs across
 * garbage and counts the spurious frame headers it meets (at 8 kHz one ADTS
 * "frame" is 0.128 s), so noise behind one valid header can reach 0.5 s. That is
 * the job of hasFrameChain().
 */
export function hasEnoughAudio (format, metadata) {
  const d = metadata && metadata.format ? metadata.format.duration : undefined
  const known = typeof d === 'number' && Number.isFinite(d)
  if (format === 'mp3' || format === 'aac') return known && d >= MIN_DURATION
  return !known || d >= MIN_DURATION
}

// ------------------------------------------------------------ frame chains
//
// MPEG audio and ADTS have no container: the only structure is that every frame
// header says how long the frame is, and the next header starts exactly there.
// Four bytes that look like one header occur by chance in any binary data; three
// headers in a row at the right distances, with the same stream parameters, do not
// (about 1 in 2^30 per position for MPEG). Real files always chain: that is how
// decoders walk them.

const CHAIN_FRAMES = 3
// Where the first chain may start: the audio start (after ID3v2 tags and zero
// padding) plus this much, for encoders that leave a little junk in between.
const CHAIN_SEARCH = 64 * 1024
const MAX_FRAME_BYTES = 8192 // ADTS frame length is 13 bits; MPEG frames are shorter
const MAX_ID3_TAGS = 4

const MPEG_RATES = [[11025, 12000, 8000], null, [22050, 24000, 16000], [44100, 48000, 32000]] // by version bits
const MPEG_KBPS = {
  v1l1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  v1l2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  v1l3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  v2l1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  v2l23: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
}

// An MPEG audio frame header at b[i]: { length, key } or null. `key` holds what
// must stay the same along a stream (version, layer, sample rate). Free-format
// streams (bitrate index 0) have no length in the header and are not accepted.
function mpegHeader (b, i) {
  if (i + 4 > b.length || b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null
  const version = (b[i + 1] >> 3) & 3 // 0 = MPEG 2.5, 1 reserved, 2 = MPEG 2, 3 = MPEG 1
  const layer = (b[i + 1] >> 1) & 3 // 1 = III, 2 = II, 3 = I, 0 reserved
  const brIndex = b[i + 2] >> 4
  const srIndex = (b[i + 2] >> 2) & 3
  if (version === 1 || layer === 0 || brIndex === 0 || brIndex === 15 || srIndex === 3) return null
  const padding = (b[i + 2] >> 1) & 1
  const rate = MPEG_RATES[version][srIndex]
  let table
  if (version === 3) table = layer === 3 ? MPEG_KBPS.v1l1 : layer === 2 ? MPEG_KBPS.v1l2 : MPEG_KBPS.v1l3
  else table = layer === 3 ? MPEG_KBPS.v2l1 : MPEG_KBPS.v2l23
  const bitrate = table[brIndex] * 1000
  let length
  if (layer === 3) length = (Math.floor((12 * bitrate) / rate) + padding) * 4 // Layer I
  else if (layer === 1 && version !== 3) length = Math.floor((72 * bitrate) / rate) + padding // Layer III, MPEG 2/2.5
  else length = Math.floor((144 * bitrate) / rate) + padding
  if (length < 4) return null
  return { length, key: (version << 4) | (layer << 2) | srIndex }
}

// An ADTS frame header at b[i]: { length, key } or null.
function adtsHeader (b, i) {
  if (i + 7 > b.length || b[i] !== 0xff || (b[i + 1] & 0xf6) !== 0xf0) return null
  const srIndex = (b[i + 2] >> 2) & 0x0f
  if (srIndex >= 13) return null
  const headerLength = (b[i + 1] & 1) === 1 ? 7 : 9 // protection_absent
  const length = ((b[i + 3] & 0x03) << 11) | (b[i + 4] << 3) | (b[i + 5] >> 5)
  if (length <= headerLength) return null
  return { length, key: ((b[i + 1] & 0x08) << 5) | (b[i + 2] & 0xc0) | srIndex } // MPEG id, profile, rate
}

function chainAt (b, i, header) {
  const first = header(b, i)
  if (first === null) return false
  let at = i + first.length
  for (let n = 1; n < CHAIN_FRAMES; n++) {
    const next = header(b, at)
    if (next === null || next.key !== first.key) return false
    at += next.length
  }
  return true
}

// Offset where the audio starts: after every ID3v2 tag at the head of the file
// (some files carry more than one).
async function audioStart (fh) {
  const h = Buffer.alloc(10)
  let offset = 0
  for (let n = 0; n < MAX_ID3_TAGS; n++) {
    const { bytesRead } = await fh.read(h, 0, 10, offset)
    if (bytesRead < 10 || ascii(h, 0, 3) !== 'ID3') break
    const size = ((h[6] & 0x7f) << 21) | ((h[7] & 0x7f) << 14) | ((h[8] & 0x7f) << 7) | (h[9] & 0x7f)
    const footer = (h[5] & 0x10) !== 0 ? 10 : 0
    offset += 10 + size + footer
  }
  return offset
}

/**
 * Does the file hold a real MPEG audio ('mp3') or ADTS ('aac') stream: CHAIN_FRAMES
 * frames in a row, starting near the beginning of the audio?
 * Reads at most about CHAIN_SEARCH + CHAIN_FRAMES * MAX_FRAME_BYTES bytes.
 */
export async function hasFrameChain (file, format) {
  const header = format === 'aac' ? adtsHeader : format === 'mp3' ? mpegHeader : null
  if (header === null) return true // not a frame-scanned format: nothing to check here
  const fh = await fs.promises.open(file, 'r')
  try {
    const start = await audioStart(fh)
    const buf = Buffer.alloc(CHAIN_SEARCH + CHAIN_FRAMES * MAX_FRAME_BYTES)
    const { bytesRead } = await fh.read(buf, 0, buf.length, start)
    const b = buf.subarray(0, bytesRead)
    const last = Math.min(b.length, CHAIN_SEARCH)
    for (let i = b.indexOf(0xff); i !== -1 && i < last; i = b.indexOf(0xff, i + 1)) {
      if (chainAt(b, i, header)) return true
    }
    return false
  } finally {
    await fh.close()
  }
}

export function sniffImage (data) {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpg'
  if (data.length >= 8 && data[0] === 0x89 && ascii(data, 1, 3) === 'PNG') return 'png'
  if (data.length >= 12 && ascii(data, 0, 4) === 'RIFF' && ascii(data, 8, 4) === 'WEBP') return 'webp'
  return null
}

/**
 * The parts of an image that make the picture: metadata is left out, so the same
 * cover with another EXIF date (the NEA album has three of those) is one cover.
 * JPEG: APP1 (EXIF, XMP), APP12, APP13 (IPTC) and COM go; APP0, ICC (APP2) and
 * Adobe (APP14) stay, they change how it decodes. PNG: text, time and EXIF chunks
 * go. WebP: EXIF and XMP chunks and the RIFF size go. Anything that does not walk
 * cleanly is hashed whole.
 */
export function coverHashParts (data, ext) {
  if (!Buffer.isBuffer(data)) data = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  try {
    if (ext === 'jpg') return jpegParts(data)
    if (ext === 'png') return pngParts(data)
    if (ext === 'webp') return webpParts(data)
  } catch {}
  return [data]
}

const JPEG_DROP = new Set([0xe1, 0xec, 0xed, 0xfe])

function jpegParts (data) {
  const parts = [data.subarray(0, 2)]
  let i = 2
  while (i + 4 <= data.length) {
    if (data[i] !== 0xff) return [data]
    const marker = data[i + 1]
    if (marker === 0xff) { i++; continue }
    if (marker === 0xda) {
      parts.push(data.subarray(i))
      return parts
    }
    const len = data.readUInt16BE(i + 2)
    if (len < 2 || i + 2 + len > data.length) return [data]
    if (!JPEG_DROP.has(marker)) parts.push(data.subarray(i, i + 2 + len))
    i += 2 + len
  }
  return [data]
}

const PNG_DROP = new Set(['tEXt', 'zTXt', 'iTXt', 'tIME', 'eXIf'])

function pngParts (data) {
  const parts = [data.subarray(0, 8)]
  let i = 8
  while (i + 12 <= data.length) {
    const len = data.readUInt32BE(i)
    const type = ascii(data, i + 4, 4)
    const end = i + 12 + len
    if (end > data.length) return [data]
    if (!PNG_DROP.has(type)) parts.push(data.subarray(i, end))
    if (type === 'IEND') return parts
    i = end
  }
  return [data]
}

function webpParts (data) {
  const parts = [data.subarray(0, 4), data.subarray(8, 12)]
  let i = 12
  while (i + 8 <= data.length) {
    const type = ascii(data, i, 4)
    const len = data.readUInt32LE(i + 4)
    const end = i + 8 + len + (len & 1)
    if (i + 8 + len > data.length) return [data]
    if (type !== 'EXIF' && type !== 'XMP ') parts.push(data.subarray(i, i + 8 + len))
    i = end
  }
  return parts
}

/**
 * Store image bytes under covers/<coverId>.<ext> (coverId = first 24 hex of the
 * SHA-256 of coverHashParts; the type comes from the bytes). Nothing is written
 * when the same image is already there.
 * @returns {string|null} coverId, null when the bytes are not a JPEG/PNG/WebP
 */
export function saveCoverBytes (data, coversDir) {
  if (!data || data.length === 0 || data.length > MAX_COVER_BYTES) return null
  const ext = sniffImage(data)
  if (ext === null || !COVER_MIME[ext]) return null
  const hash = crypto.createHash('sha256')
  for (const part of coverHashParts(data, ext)) hash.update(part)
  const coverId = hash.digest('hex').slice(0, 24)
  const file = path.join(coversDir, coverId + '.' + ext)
  if (!fs.existsSync(file)) {
    writeAtomicSync(file, data, 0o644)
  }
  return coverId
}

/**
 * Store the embedded cover (front cover preferred) under covers/<coverId>.<ext>.
 * The image type comes from its bytes, not from the tag's declared MIME type.
 * @returns {string|null} coverId
 */
export function saveCover (metadata, coversDir) {
  const pictures = metadata.common && metadata.common.picture
  if (!pictures || pictures.length === 0) return null
  const picture = selectCover(pictures)
  if (!picture || !picture.data || picture.data.length === 0) return null
  return saveCoverBytes(Buffer.from(picture.data.buffer, picture.data.byteOffset, picture.data.byteLength), coversDir)
}

/**
 * Lossless original? FLAC, WAV, or ALAC inside MP4 ("max" is then lossless).
 */
export function isLossless (format, metadata) {
  if (format === 'flac' || format === 'wav') return true
  if (format !== 'm4a') return false
  const fmt = (metadata && metadata.format) || {}
  return /alac/i.test(String(fmt.codec || '')) || /alac/i.test(String(fmt.codecId || ''))
}

function cleanTag (value, max = 500) {
  if (typeof value !== 'string') return ''
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max)
}

function positiveInt (n) {
  return Number.isInteger(n) && n > 0 ? n : null
}

// The fields a track may get from its file's tags (and `cover`, its picture).
export const TAGLESS_FIELDS = ['title', 'artist', 'albumArtist', 'album', 'year', 'trackNo', 'discNo', 'cover']

/**
 * The fields the file has no tag for, from music-metadata's `common`. `cover`:
 * no embedded picture (`coverId` null).
 */
export function taglessOf (common, coverId) {
  const c = common || {}
  const out = []
  if (!cleanTag(c.title)) out.push('title')
  if (!cleanTag(c.artist)) out.push('artist')
  if (!cleanTag(c.albumartist)) out.push('albumArtist')
  if (!cleanTag(c.album)) out.push('album')
  if (positiveInt(c.year) === null) out.push('year')
  if (positiveInt(c.track && c.track.no) === null) out.push('trackNo')
  if (positiveInt(c.disk && c.disk.no) === null) out.push('discNo')
  if (!coverId) out.push('cover')
  return out
}

/** The sort tags (artist, album artist, album, title), cleaned: null when there are none. */
export function sortOf (c) {
  const out = {}
  for (const [k, v] of [['artist', c.artistsort], ['albumArtist', c.albumartistsort], ['album', c.albumsort], ['title', c.titlesort]]) {
    const x = cleanTag(v)
    if (x) out[k] = x
  }
  return Object.keys(out).length > 0 ? out : null
}

/** The ReplayGain and R128 numbers of the tags, as loudness.js takes them. */
export function gainTagsOf (metadata) {
  const c = metadata.common || {}
  const native = metadata.native || {}
  const db = (x) => (x && typeof x.dB === 'number' ? x.dB : null)
  const ratio = (x) => (x && typeof x.ratio === 'number' ? x.ratio : null)
  const r128 = (id) => {
    for (const list of Object.values(native)) {
      for (const tag of Array.isArray(list) ? list : []) {
        if (tag && typeof tag.id === 'string' && tag.id.toUpperCase() === id && /^-?\d+$/.test(String(tag.value).trim())) return Number(String(tag.value).trim())
      }
    }
    return null
  }
  return { trackGain: db(c.replaygain_track_gain), trackPeak: ratio(c.replaygain_track_peak), albumGain: db(c.replaygain_album_gain), albumPeak: ratio(c.replaygain_album_peak), r128Track: r128('R128_TRACK_GAIN'), r128Album: r128('R128_ALBUM_GAIN') }
}

/**
 * Build the track object from parsed metadata.
 * @param {object} p
 * @param {string} p.id         first 24 hex of the content SHA-256
 * @param {string} p.format     key of AUDIO_FORMATS
 * @param {object} p.metadata   music-metadata result
 * @param {number} p.size       file size in bytes
 * @param {string} p.fallbackTitle  the upload's file name without extension
 * @param {string|null} p.coverId
 * @param {number} p.addedAt
 */
export function buildTrack ({ id, format, metadata, size, fallbackTitle, coverId, addedAt }) {
  const common = metadata.common || {}
  const fmt = metadata.format || {}
  const title = cleanTag(common.title) || fallbackTitle || id
  const artist = cleanTag(common.artist) || UNKNOWN_ARTIST
  const album = cleanTag(common.album) || UNKNOWN_ALBUM
  const albumArtist = cleanTag(common.albumartist) || artist
  const duration = typeof fmt.duration === 'number' && Number.isFinite(fmt.duration) ? Math.round(fmt.duration * 1000) / 1000 : null
  const bitrate = typeof fmt.bitrate === 'number' && Number.isFinite(fmt.bitrate) ? Math.round(fmt.bitrate) : null
  const lossless = isLossless(format, metadata)
  const sampleRate = typeof fmt.sampleRate === 'number' && fmt.sampleRate > 0 ? Math.round(fmt.sampleRate) : null
  const bitDepth = lossless && typeof fmt.bitsPerSample === 'number' && fmt.bitsPerSample > 0 ? fmt.bitsPerSample : null
  return {
    id,
    title,
    artist,
    album,
    albumArtist,
    trackNo: positiveInt(common.track && common.track.no),
    discNo: positiveInt(common.disk && common.disk.no),
    year: positiveInt(common.year),
    duration,
    format,
    mime: AUDIO_FORMATS[format].mime,
    size,
    bitrate,
    lossless,
    addedAt,
    coverId: coverId || null,
    codec: codecOf(format, lossless, fmt.codec),
    sampleRate,
    bitDepth,
    tagless: taglessOf(common, coverId),
    genres: splitGenres(common.genre || []),
    sort: sortOf(common),
    loud: loudFromTags(gainTagsOf(metadata))
  }
}
