// Writes resources/local/vectors.json: what the source makes of a few byte strings (the
// sniffed audio container, the cover id), so the app's own copies of those rules are checked
// against the source's code, not against a second reading of it.
//
//   node android/app/src/test/vectors.mjs

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sniffAudio, sniffImage, coverHashParts, MAX_COVER_BYTES } from '../../../../server/media.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(here, 'resources', 'local', 'vectors.json')

const b = (...parts) => Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))))
const u16 = (n) => Buffer.from([(n >> 8) & 0xff, n & 0xff])
const u32 = (n) => { const x = Buffer.alloc(4); x.writeUInt32BE(n); return x }
const u32le = (n) => { const x = Buffer.alloc(4); x.writeUInt32LE(n); return x }
const seg = (marker, body) => b([0xff, marker], u16(body.length + 2), body)
const chunk = (type, body) => b(u32(body.length), type, body, [0x11, 0x22, 0x33, 0x44])
const riff = (type, body) => b(type, u32le(body.length), body, body.length & 1 ? [0] : [])
const fill = (n, seed) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff))

const scan = b([0xff, 0xda], u16(8), [1, 1, 0, 0, 0x3f, 0], fill(300, 5), [0xff, 0xd9])
const jpeg = (app1, com) => b([0xff, 0xd8], seg(0xe0, b('JFIF\0', [1, 1, 0, 0, 1, 0, 1, 0, 0])), seg(0xe1, b('Exif\0\0', app1)), seg(0xdb, fill(65, 9)), seg(0xfe, b(com)), scan)

const covers = {
  'jpeg with exif and a comment': jpeg(fill(40, 1), 'made on a phone'),
  'the same jpeg, other exif and comment': jpeg(fill(90, 3), 'another comment'),
  'jpeg with fill bytes before a marker': b([0xff, 0xd8], [0xff, 0xff], seg(0xe0, b('JFIF\0', [1, 1])), seg(0xed, fill(20, 2)), seg(0xec, fill(10, 4)), scan),
  'jpeg with an adobe segment kept': b([0xff, 0xd8], seg(0xee, b('Adobe', fill(7, 8))), seg(0xe2, b('ICC_PROFILE\0', fill(30, 6))), scan),
  'broken jpeg, a segment past the end': b([0xff, 0xd8], [0xff, 0xe1, 0x40, 0x00], fill(100, 7)),
  'jpeg that never reaches its scan': b([0xff, 0xd8], seg(0xe0, b('JFIF\0')), seg(0xdb, fill(10, 3))),
  png: b([0x89], 'PNG\r\n\x1a\n', chunk('IHDR', fill(13, 1)), chunk('tEXt', b('Comment\0a phone')), chunk('tIME', fill(7, 2)), chunk('IDAT', fill(200, 3)), chunk('IEND', Buffer.alloc(0))),
  'png with a chunk past the end': b([0x89], 'PNG\r\n\x1a\n', chunk('IHDR', fill(13, 1)), u32(5000), 'IDAT', fill(30, 2)),
  webp: (() => {
    const body = b('WEBP', riff('VP8 ', fill(101, 4)), riff('EXIF', fill(33, 5)), riff('XMP ', fill(12, 6)), riff('ICCP', fill(20, 7)))
    return b('RIFF', u32le(body.length), body)
  })(),
  'webp with a chunk past the end': b('RIFF', u32le(40), 'WEBP', 'VP8 ', u32le(900), fill(20, 1)),
  gif: b('GIF89a', fill(50, 2)),
  empty: Buffer.alloc(0)
}

function coverId (data) {
  if (data.length === 0 || data.length > MAX_COVER_BYTES) return null
  const ext = sniffImage(data)
  if (ext === null) return null
  const hash = crypto.createHash('sha256')
  for (const part of coverHashParts(data, ext)) hash.update(part)
  return hash.digest('hex').slice(0, 24)
}

const heads = {
  id3: b('ID3', [4, 0, 0, 0, 0, 0, 10], fill(40, 1)),
  flac: b('fLaC', fill(40, 2)),
  ogg: b('OggS', [0, 2], fill(20, 3), [1, 0x1e], [1], 'vorbis', fill(20, 3)),
  opus: b('OggS', [0, 2], fill(20, 3), 'OpusHead', fill(20, 4)),
  wav: b('RIFF', u32le(1000), 'WAVE', 'fmt ', fill(20, 5)),
  m4a: b(u32(32), 'ftypM4A ', fill(30, 6)),
  'mpeg frame after zeros': b(Buffer.alloc(12), [0xff, 0xfb, 0x90, 0x64], fill(40, 7)),
  'adts frame': b([0xff, 0xf1, 0x50, 0x80], fill(40, 8)),
  'mpeg with a bad bitrate': b([0xff, 0xfb, 0xf0, 0x64], fill(40, 9)),
  'riff that is not wave': b('RIFF', u32le(1000), 'AVI ', fill(20, 5)),
  'three bytes': b('ID3'),
  amr: b('#!AMR\n', fill(40, 1)),
  'only zeros': Buffer.alloc(64)
}

// An MPEG frame header, then 700,001 bytes: its id is the first 24 hex of its SHA-256, as an upload's.
const whole = b([0xff, 0xfb, 0x90, 0x64], fill(700001, 7))

const doc = {
  covers: Object.entries(covers).map(([name, data]) => ({ name, hex: data.toString('hex'), ext: sniffImage(data), id: coverId(data) })),
  sniff: Object.entries(heads).map(([name, data]) => ({ name, hex: data.toString('hex'), format: sniffAudio(data) })),
  file: { head: 'fffb9064', length: 700001, seed: 7, format: sniffAudio(whole.subarray(0, 4096)), id: crypto.createHash('sha256').update(whole).digest('hex').slice(0, 24) }
}

fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, JSON.stringify(doc, null, 1) + '\n')
console.log('wrote ' + path.relative(process.cwd(), out) + ': ' + doc.covers.length + ' covers, ' + doc.sniff.length + ' heads')
