// Small audio files with lyrics in their tags, for the tests: ID3 USLT and SYLT
// frames for makeMp3, a FLAC with Vorbis comments, an M4A with an iTunes list.
// Every lyric line in them is invented.

// An ID3v2.3 text of encoding 0 (ISO-8859-1), null-terminated.
function latin1z (s) {
  return Buffer.concat([Buffer.from(s, 'latin1'), Buffer.from([0])])
}

/** An ID3v2.3 USLT frame body (unsynchronized lyrics, ISO-8859-1). */
export function usltFrame (text, { lang = 'ita', descriptor = '' } = {}) {
  return ['USLT', Buffer.concat([Buffer.from([0]), Buffer.from(lang, 'latin1'), latin1z(descriptor), Buffer.from(text, 'latin1')])]
}

/**
 * An ID3v2.3 SYLT frame body: `lines` [{ t, text }], times in milliseconds
 * (format 2), or in MPEG frames with `format: 1`.
 */
export function syltFrame (lines, { lang = 'ita', format = 2, descriptor = '' } = {}) {
  const parts = [Buffer.from([0]), Buffer.from(lang, 'latin1'), Buffer.from([format, 1]), latin1z(descriptor)]
  for (const l of lines) {
    const t = Buffer.alloc(4)
    t.writeUInt32BE(l.t)
    parts.push(latin1z(l.text), t)
  }
  return ['SYLT', Buffer.concat(parts)]
}

function block (type, body, last) {
  const head = Buffer.alloc(4)
  head[0] = (last ? 0x80 : 0) | type
  head.writeUIntBE(body.length, 1, 3)
  return Buffer.concat([head, body])
}

/**
 * A FLAC: STREAMINFO (44.1 kHz, stereo, 16 bit, `seconds` long) and a Vorbis
 * comment block with `comments` ({ KEY: value }), then a few zero bytes.
 */
export function makeFlac ({ seconds = 3, comments = {} } = {}) {
  const info = Buffer.alloc(34)
  info.writeUInt16BE(4096, 0)
  info.writeUInt16BE(4096, 2)
  // sample rate (20 bits), channels - 1 (3 bits), bits per sample - 1 (5 bits), total samples (36 bits)
  const rate = 44100
  const total = BigInt(rate * seconds)
  let v = (BigInt(rate) << 44n) | (1n << 41n) | (15n << 36n) | total
  for (let i = 7; i >= 0; i--) {
    info[10 + i] = Number(v & 0xffn)
    v >>= 8n
  }
  const vendor = Buffer.from('mpfy-test', 'utf8')
  const list = Object.entries(comments).map(([k, val]) => Buffer.from(k + '=' + val, 'utf8'))
  const parts = []
  const u32 = (n) => {
    const b = Buffer.alloc(4)
    b.writeUInt32LE(n)
    return b
  }
  parts.push(u32(vendor.length), vendor, u32(list.length))
  for (const c of list) parts.push(u32(c.length), c)
  return Buffer.concat([Buffer.from('fLaC', 'latin1'), block(0, info, false), block(4, Buffer.concat(parts), true), Buffer.alloc(64)])
}

function box (type, ...body) {
  const payload = Buffer.concat(body)
  const head = Buffer.alloc(8)
  head.writeUInt32BE(8 + payload.length)
  head.write(type, 4, 'latin1')
  return Buffer.concat([head, payload])
}

function fullBox (type, version, flags, ...body) {
  const vf = Buffer.alloc(4)
  vf.writeUInt32BE(((version & 0xff) << 24) | (flags & 0xffffff))
  return box(type, vf, ...body)
}

// An iTunes list item: the atom with one UTF-8 data atom.
function item (type, text) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(1) // well-known type 1: UTF-8
  return box(type, box('data', head, Buffer.from(text, 'utf8')))
}

/**
 * An M4A (AAC in MP4, `seconds` long at 44.1 kHz) whose iTunes list holds a
 * title, an artist and `lyrics` (©lyr).
 */
export function makeM4a ({ seconds = 3, title = 'Brano', artist = 'Lumen Marino', lyrics = null } = {}) {
  const rate = 44100
  const ftyp = box('ftyp', Buffer.from('M4A ', 'latin1'), Buffer.from([0, 0, 2, 0]), Buffer.from('M4A mp42isom', 'latin1'))
  const mvhd = Buffer.alloc(96)
  mvhd.writeUInt32BE(rate, 8) // time scale
  mvhd.writeUInt32BE(rate * seconds, 12) // duration
  mvhd.writeUInt32BE(0x00010000, 16) // rate 1.0
  mvhd.writeUInt16BE(0x0100, 20) // volume 1.0
  mvhd.writeUInt32BE(2, 92) // next track id
  const tkhd = Buffer.alloc(80)
  tkhd.writeUInt32BE(1, 8) // track id
  tkhd.writeUInt32BE(rate * seconds, 16)
  const mdhd = Buffer.alloc(20)
  mdhd.writeUInt32BE(rate, 8)
  mdhd.writeUInt32BE(rate * seconds, 12)
  mdhd.writeUInt16BE(0x55c4, 16) // language "und"
  const hdlr = (kind) => fullBox('hdlr', 0, 0, Buffer.alloc(4), Buffer.from(kind, 'latin1'), Buffer.alloc(12), Buffer.from([0]))
  // mp4a sample entry: reserved 6, data reference 1, reserved 8, channels 2, bits 16, reserved 4, rate 16.16
  const mp4a = Buffer.alloc(28)
  mp4a.writeUInt16BE(1, 6)
  mp4a.writeUInt16BE(2, 16)
  mp4a.writeUInt16BE(16, 18)
  mp4a.writeUInt32BE(rate * 65536, 24)
  // esds: an ES descriptor with the decoder config of AAC LC (object type 0x40).
  const esds = fullBox('esds', 0, 0, Buffer.from([
    0x03, 0x19, 0x00, 0x01, 0x00,
    0x04, 0x11, 0x40, 0x15, 0x00, 0x00, 0x00, 0x00, 0x01, 0xf4, 0x00, 0x00, 0x01, 0xf4, 0x00,
    0x05, 0x02, 0x12, 0x10,
    0x06, 0x01, 0x02
  ]))
  const stsd = fullBox('stsd', 0, 0, Buffer.from([0, 0, 0, 1]), box('mp4a', mp4a, esds))
  const empty = (type) => fullBox(type, 0, 0, Buffer.alloc(4))
  const stbl = box('stbl', stsd, empty('stts'), empty('stsc'), fullBox('stsz', 0, 0, Buffer.alloc(8)), empty('stco'))
  const minf = box('minf', fullBox('smhd', 0, 0, Buffer.alloc(4)), box('dinf', fullBox('dref', 0, 0, Buffer.from([0, 0, 0, 1]), fullBox('url ', 0, 1))), stbl)
  const trak = box('trak', fullBox('tkhd', 0, 7, tkhd), box('mdia', fullBox('mdhd', 0, 0, mdhd), hdlr('soun'), minf))
  const items = [item('©nam', title), item('©ART', artist)]
  if (lyrics !== null) items.push(item('©lyr', lyrics))
  const udta = box('udta', fullBox('meta', 0, 0, hdlr('mdir'), box('ilst', ...items)))
  const moov = box('moov', fullBox('mvhd', 0, 0, mvhd), trak, udta)
  return Buffer.concat([ftyp, moov, box('mdat', Buffer.alloc(16))])
}
