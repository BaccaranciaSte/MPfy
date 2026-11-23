// Test helpers: temp dirs, synthetic audio files, a small HTTP client.

import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { Duplex } from 'node:stream'
import sodium from 'sodium-native'

export function tmpDir (prefix = 'mpfy-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

export function rmDir (dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch {}
}

const cleanups = new WeakMap()

/**
 * One after-hook per test that first closes everything the test handed to
 * `closes` (apps, in order), THEN removes the directories handed to `dirs`.
 * node:test runs after-hooks in the order they were registered, so a rmDir hook
 * registered before an app's close hook pulls the data dir from under that app's
 * last db.json write.
 * @returns {{ close<T>(x: T): T, dir(d: string): string }}
 */
export function cleanup (t) {
  let c = cleanups.get(t)
  if (c === undefined) {
    const closes = []
    const dirs = []
    c = {
      close (x) {
        closes.push(x)
        return x
      },
      dir (d) {
        dirs.push(d)
        return d
      }
    }
    cleanups.set(t, c)
    t.after(async () => {
      for (const x of closes) await x.close()
      for (const d of dirs) rmDir(d)
    })
  }
  return c
}

function infoChunk (tags) {
  const parts = []
  for (const [id, value] of [['INAM', tags.title], ['IART', tags.artist], ['IPRD', tags.album]]) {
    if (!value) continue
    let text = Buffer.from(value + '\0', 'latin1')
    const size = text.length
    if (text.length % 2) text = Buffer.concat([text, Buffer.alloc(1)])
    const head = Buffer.alloc(8)
    head.write(id, 0, 'latin1')
    head.writeUInt32LE(size, 4)
    parts.push(head, text)
  }
  const body = Buffer.concat([Buffer.from('INFO', 'latin1'), ...parts])
  const head = Buffer.alloc(8)
  head.write('LIST', 0, 'latin1')
  head.writeUInt32LE(body.length, 4)
  return Buffer.concat([head, body])
}

/**
 * A valid PCM WAV file (16 bit mono). Different `freq`/`phase` give different
 * samples, hence a different content hash.
 */
export function makeWav ({ seconds = 1, sampleRate = 8000, freq = 440, phase = 0, tags = null } = {}) {
  const n = Math.round(seconds * sampleRate)
  const data = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / sampleRate + phase) * 12000), i * 2)
  }
  const list = tags ? infoChunk(tags) : Buffer.alloc(0)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0, 'latin1')
  h.writeUInt32LE(36 + data.length + list.length, 4)
  h.write('WAVE', 8, 'latin1')
  h.write('fmt ', 12, 'latin1')
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20) // PCM
  h.writeUInt16LE(1, 22) // mono
  h.writeUInt32LE(sampleRate, 24)
  h.writeUInt32LE(sampleRate * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36, 'latin1')
  h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data, list])
}

function syncsafe (n) {
  return Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f])
}

function id3Frame (id, data) {
  const head = Buffer.alloc(10)
  head.write(id, 0, 'latin1')
  head.writeUInt32BE(data.length, 4)
  return Buffer.concat([head, data])
}

/** A fake but parseable PNG (signature + IHDR), enough for cover detection. */
export function fakePng (seed = 1) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const body = Buffer.alloc(64, seed & 0xff)
  return Buffer.concat([sig, body])
}

/**
 * Bytes that pass as a profile photo (FF D8 FF in front, FF D9 at the end), `size`
 * long in all; different seeds give different bytes.
 */
export function fakeJpeg (seed = 1, size = 20000) {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), noise('jpeg:' + seed, size - 6), Buffer.from([0xff, 0xd9])])
}

// MPEG-1 Layer III bitrate indexes.
const MP3_KBPS = { 32: 1, 40: 2, 48: 3, 56: 4, 64: 5, 80: 6, 96: 7, 112: 8, 128: 9, 160: 10, 192: 11, 224: 12, 256: 13, 320: 14 }

/**
 * An MP3: an ID3v2.3 tag (title, artist, album, optional APIC cover, then any
 * `extraFrames` as [id, body]) followed by `frames` silent MPEG-1 Layer III
 * frames (`kbps`, default 128; 44.1 kHz, mono).
 */
export function makeMp3 ({ frames = 40, title, artist, album, cover = null, fill = 0, kbps = 128, extraFrames = [] } = {}) {
  const tagFrames = []
  const text = (id, v) => v && tagFrames.push(id3Frame(id, Buffer.concat([Buffer.from([0]), Buffer.from(v, 'latin1')])))
  text('TIT2', title)
  text('TPE1', artist)
  text('TALB', album)
  if (cover) {
    tagFrames.push(id3Frame('APIC', Buffer.concat([
      Buffer.from([0]), Buffer.from('image/png\0', 'latin1'), Buffer.from([3]), Buffer.from([0]), cover
    ])))
  }
  for (const [id, data] of extraFrames) tagFrames.push(id3Frame(id, data))
  const tagBody = Buffer.concat(tagFrames)
  const tag = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([3, 0, 0]), syncsafe(tagBody.length), tagBody])
  const frame = Buffer.alloc(Math.floor((144 * kbps * 1000) / 44100), fill)
  frame[0] = 0xff
  frame[1] = 0xfb
  frame[2] = MP3_KBPS[kbps] << 4
  frame[3] = 0xc0
  return Buffer.concat([tag, ...Array.from({ length: frames }, () => frame)])
}

const OGG_CRC = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let r = i << 24
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1
    t[i] = r >>> 0
  }
  return t
})()

function oggPage ({ type = 0, granule = 0n, seq, packets }) {
  const lacing = []
  for (const p of packets) {
    let n = p.length
    while (n >= 255) {
      lacing.push(255)
      n -= 255
    }
    lacing.push(n)
  }
  const head = Buffer.alloc(27)
  head.write('OggS', 0, 'latin1')
  head[5] = type
  head.writeBigUInt64LE(BigInt(granule), 6)
  head.writeUInt32LE(0x4d504659, 14) // stream serial
  head.writeUInt32LE(seq, 18)
  head[26] = lacing.length
  const page = Buffer.concat([head, Buffer.from(lacing), ...packets])
  let crc = 0
  for (const b of page) crc = ((crc << 8) ^ OGG_CRC[((crc >>> 24) ^ b) & 0xff]) >>> 0
  page.writeUInt32LE(crc, 22)
  return page
}

/**
 * An Ogg Opus file: OpusHead, OpusTags, then `seconds` of 20 ms packets sized for
 * `kbps` (silent CELT frames, as far as a parser looks).
 */
export function makeOggOpus ({ seconds = 10, kbps = 256 } = {}) {
  const head = Buffer.alloc(19)
  head.write('OpusHead', 0, 'latin1')
  head[8] = 1 // version
  head[9] = 2 // channels
  head.writeUInt16LE(312, 10) // pre-skip
  head.writeUInt32LE(48000, 12)
  const tags = Buffer.concat([Buffer.from('OpusTags', 'latin1'), Buffer.from([4, 0, 0, 0]), Buffer.from('fake', 'latin1'), Buffer.alloc(4)])
  const pages = [oggPage({ type: 2, seq: 0, packets: [head] }), oggPage({ seq: 1, packets: [tags] })]
  const packetBytes = Math.round((kbps * 1000) / 8 * 0.02)
  const total = Math.round(seconds * 50)
  let seq = 2
  for (let i = 0; i < total; i += 10) {
    const n = Math.min(10, total - i)
    const packets = Array.from({ length: n }, () => {
      const p = Buffer.alloc(packetBytes)
      p[0] = 0xfc // CELT fullband 20 ms, stereo, one frame
      return p
    })
    const last = i + n >= total
    pages.push(oggPage({ type: last ? 4 : 0, granule: BigInt(312 + (i + n) * 960), seq: seq++, packets }))
  }
  return Buffer.concat(pages)
}

/** `n` bytes of deterministic noise (a SHA-256 counter stream): the same for a seed. */
export function noise (seed, n) {
  const out = Buffer.alloc(n)
  for (let off = 0, i = 0; off < n; i++) {
    const block = crypto.createHash('sha256').update('mpfy-noise:' + seed + ':' + i).digest()
    off += block.copy(out, off)
  }
  return out
}

/**
 * A raw AAC stream: `frames` ADTS frames (MPEG-4 AAC LC, 44.1 kHz, stereo, no CRC),
 * each `frameLength` bytes long with a zero payload (1024 samples per frame).
 */
export function makeAdts ({ frames = 50, frameLength = 200 } = {}) {
  const frame = Buffer.alloc(frameLength)
  frame[0] = 0xff
  frame[1] = 0xf1 // MPEG-4, layer 0, protection absent
  frame[2] = 0x50 // profile LC, sampling index 4 (44.1 kHz), channel config high bit 0
  frame[3] = 0x80 | ((frameLength >> 11) & 0x03) // channel config 2, length bits 12-11
  frame[4] = (frameLength >> 3) & 0xff
  frame[5] = ((frameLength & 0x07) << 5) | 0x1f // buffer fullness 0x7ff (VBR)
  frame[6] = 0xfc // one raw data block
  return Buffer.concat(Array.from({ length: frames }, () => frame))
}

/**
 * HTTP request on 127.0.0.1 without connection reuse (each request is its own TCP
 * connection, which also exercises open/close through the P2P pipe).
 */
export function request (port, method, urlPath, { headers = {}, body = null, timeout = 30000, localAddress = undefined } = {}) {
  return new Promise((resolve, reject) => {
    let payload = null
    const h = { ...headers }
    if (body !== null && body !== undefined) {
      if (Buffer.isBuffer(body) || typeof body === 'string') {
        payload = body
      } else {
        payload = JSON.stringify(body)
        h['content-type'] = 'application/json'
      }
      h['content-length'] = Buffer.byteLength(payload)
    }
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: h, agent: false, localAddress }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
      res.on('error', reject)
    })
    req.setTimeout(timeout, () => req.destroy(new Error('request timeout ' + method + ' ' + urlPath)))
    req.on('error', reject)
    req.end(payload === null ? undefined : payload)
  })
}

export function json (res) {
  return JSON.parse(res.body.toString('utf8'))
}

/**
 * Two connected in-memory streams that keep message boundaries (like a secret
 * stream) and propagate backpressure: a writer waits while the peer's readable
 * side is full. Used to run protomux without a network.
 */
export function framedPair ({ highWaterMark = 8 } = {}) {
  const sides = []
  const make = (self) => new Duplex({
    objectMode: true,
    highWaterMark,
    read () {
      const cb = self.waiting
      if (cb) {
        self.waiting = null
        cb()
      }
    },
    write (chunk, encoding, cb) {
      const peer = sides[1 - self.index].stream
      if (peer.destroyed) return cb()
      if (peer.push(Buffer.from(chunk))) cb()
      else sides[1 - self.index].waiting = cb
    },
    final (cb) {
      const peer = sides[1 - self.index].stream
      if (!peer.destroyed) peer.push(null)
      cb()
    },
    destroy (err, cb) {
      const peer = sides[1 - self.index].stream
      if (!peer.destroyed) setImmediate(() => peer.destroy())
      cb(err)
    }
  })
  for (let i = 0; i < 2; i++) {
    const self = { index: i, waiting: null, stream: null }
    sides.push(self)
    self.stream = make(self)
  }
  return [sides[0].stream, sides[1].stream]
}

export function listenServer (server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve(server.address().port)
    })
  })
}

export function closeServer (server) {
  return new Promise((resolve) => server.close(() => resolve()))
}

/**
 * A private copy of the fake ffmpeg (test/fake-ffmpeg.mjs) in `dir`, with its own
 * control file and call log.
 * @returns {{ command: string, control(obj): void, calls(): Array<{args, start, end}> }}
 */
export function fakeFfmpeg (dir, control = {}) {
  const command = path.join(dir, 'fake-ffmpeg.mjs')
  fs.copyFileSync(new URL('./fake-ffmpeg.mjs', import.meta.url), command)
  const controlFile = path.join(dir, 'fake-ffmpeg.json')
  const logFile = path.join(dir, 'fake-ffmpeg-calls.log')
  const startedFile = path.join(dir, 'fake-ffmpeg-started.log')
  const set = (obj) => fs.writeFileSync(controlFile, JSON.stringify(obj))
  const lines = (file) => {
    let text = ''
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {}
    return text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
  }
  set(control)
  return {
    command,
    control: set,
    calls: () => lines(logFile),
    /** Calls that have read their control (running or over). */
    started: () => lines(startedFile)
  }
}

/** Poll `fn` until it returns a truthy value (or fail after `timeout` ms). */
export async function waitFor (fn, { timeout = 10000, interval = 20, what = 'condition' } = {}) {
  const until = Date.now() + timeout
  while (true) {
    const value = await fn()
    if (value) return value
    if (Date.now() > until) throw new Error('timed out waiting for ' + what)
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
}

// --------------------------------------------------------------- profiles

/**
 * A profile from its 32-byte secret, as the client core makes it:
 * signSeed = BLAKE2b-256("mpfy/profile-sign/1" || secret), Ed25519 key pair,
 * id = first 16 bytes of BLAKE2b-256("mpfy/profile-id/1" || signPublicKey).
 */
export function makeProfile (secret = crypto.randomBytes(32)) {
  const h = (...parts) => {
    const out = Buffer.alloc(32)
    sodium.crypto_generichash(out, Buffer.concat(parts))
    return out
  }
  const seed = h(Buffer.from('mpfy/profile-sign/1'), secret)
  const signPublicKey = Buffer.alloc(32)
  const signSecretKey = Buffer.alloc(64)
  sodium.crypto_sign_seed_keypair(signPublicKey, signSecretKey, seed)
  const id = h(Buffer.from('mpfy/profile-id/1'), signPublicKey).subarray(0, 16).toString('hex')
  return { secret, id, signPublicKey, signSecretKey }
}

/** The chat key pair of a profile secret: crypto_box_seed_keypair(BLAKE2b-256("mpfy/chat-key/1" || secret)). */
export function chatKeysOf (secret) {
  const seed = Buffer.alloc(32)
  sodium.crypto_generichash(seed, Buffer.concat([Buffer.from('mpfy/chat-key/1'), secret]))
  const publicKey = Buffer.alloc(32)
  const secretKey = Buffer.alloc(32)
  sodium.crypto_box_seed_keypair(publicKey, secretKey, seed)
  return { publicKey, secretKey }
}

/**
 * A profile card signed by `profile` (makeProfile): sig over "mpfy/card/1" || the
 * JSON of [1, profileId, chatPublicKey, name, photo, updatedAt]. `fields` replace
 * what goes in the card after signing it (to make a bad one).
 */
export function makeCard (profile, { name = 'Prova', photo = null, updatedAt = Date.now(), chatPublicKey = null } = {}, fields = {}) {
  const chat = chatPublicKey || chatKeysOf(profile.secret).publicKey.toString('hex')
  const bytes = Buffer.concat([Buffer.from('mpfy/card/1'), Buffer.from(JSON.stringify([1, profile.id, chat, name, photo, updatedAt]), 'utf8')])
  const sig = Buffer.alloc(64)
  sodium.crypto_sign_detached(sig, bytes, profile.signSecretKey)
  return {
    v: 1,
    profileId: profile.id,
    signPublicKey: profile.signPublicKey.toString('hex'),
    chatPublicKey: chat,
    name,
    photo,
    updatedAt,
    sig: sig.toString('hex'),
    ...fields
  }
}

/** The two profile headers for `profile` on the link of `clientKey` to `serverKey` (hex). */
export function proofHeaders (profile, clientKey, serverKey) {
  const message = Buffer.concat([Buffer.from('mpfy/profile/1'), Buffer.from(clientKey, 'hex'), Buffer.from(serverKey, 'hex')])
  const signature = Buffer.alloc(64)
  sodium.crypto_sign_detached(signature, message, profile.signSecretKey)
  return {
    'x-mpfy-profile': profile.id,
    'x-mpfy-profile-proof': Buffer.concat([profile.signPublicKey, signature]).toString('hex')
  }
}

/** A random device key (64 hex). */
export function deviceKey () {
  return crypto.randomBytes(32).toString('hex')
}

// Tests stand in for the transport: a request from 127.0.0.2 carrying this
// header is "from" that admitted client (createMPfy({ whoIs: testWhoIs })).
export const testWhoIs = (req) => {
  const v = req.headers['x-test-client']
  return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) ? v : null
}

/**
 * A device of the test: an admitted key, optionally with a profile. call()
 * sends from 127.0.0.2 as that device, with the profile headers when it has one.
 */
export function device (app, { profile = null, name = 'Dispositivo di prova', legacy = false, admit = true, key = deviceKey() } = {}) {
  if (admit) {
    app.clients.add(key, name)
    if (legacy) {
      const list = JSON.parse(fs.readFileSync(app.clients.file, 'utf8'))
      for (const c of list) if (c.publicKey === key) c.legacy = true
      fs.writeFileSync(app.clients.file, JSON.stringify(list, null, 2))
    }
  }
  const call = (method, urlPath, { headers = {}, body = null, timeout, withProfile = true } = {}) => {
    const h = { 'x-test-client': key }
    if (profile !== null && withProfile) Object.assign(h, proofHeaders(profile, key, app.serverPublicKey))
    Object.assign(h, headers)
    return request(app.ports.http, method, urlPath, { headers: h, body, timeout, localAddress: '127.0.0.2' })
  }
  return { key, profile, call, on: (other) => device(other, { profile, key, admit: false }) }
}

// ------------------------------------------------------------- fake tools

/**
 * A private copy of a fake tool (test/fake-<name>.mjs) in `dir`, with its own
 * control file and call log.
 * @returns {{ command: string, control(obj): void, calls(): Array }}
 */
export function fakeTool (dir, name, control = {}) {
  const command = path.join(dir, 'fake-' + name + '.mjs')
  fs.copyFileSync(new URL('./fake-' + name + '.mjs', import.meta.url), command)
  const controlFile = path.join(dir, 'fake-' + name + '.json')
  const logFile = path.join(dir, 'fake-' + name + '-calls.log')
  const set = (obj) => fs.writeFileSync(controlFile, JSON.stringify(obj))
  set(control)
  return {
    command,
    control: set,
    calls () {
      let text = ''
      try {
        text = fs.readFileSync(logFile, 'utf8')
      } catch {}
      return text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
    }
  }
}

/** First 24 hex of the SHA-256 of some bytes (a track id, a file hash). */
export function hash24 (buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 24)
}

/**
 * A fingerprint: `n` pseudo-random u32 items from a seed; `flip` bits changed in
 * every item (a similar recording); `shift` items dropped from the front.
 */
export function fingerprintOf (seed, { n = 970, flip = 0, shift = 0, flipSeed = 'x' } = {}) {
  const raw = noise('fp:' + seed, (n + shift) * 4)
  const bits = noise('flip:' + seed + ':' + flipSeed, (n + shift) * 32)
  const items = []
  for (let i = shift; i < n + shift; i++) {
    let v = raw.readUInt32LE(i * 4)
    const used = new Set()
    for (let b = 0, j = 0; b < flip; j++) {
      const bit = bits[(i * 32 + j) % bits.length] % 32
      if (used.has(bit)) continue
      used.add(bit)
      v ^= 1 << bit
      b++
    }
    items.push(v >>> 0)
  }
  return items
}

// ------------------------------------------------------------------ zips

/**
 * A ZIP file. entries: [{ name, data, method (0 stored, 8 deflate, any other
 * number: the bytes as they are under that method), encrypted, symlink, dir,
 * rawName (a Buffer: the name as bytes, without the UTF-8 flag), comment (a
 * Buffer in the central record) }].
 * opts.overlap: one more central record pointing at the first local header.
 */
export function makeZip (entries, { overlap = false } = {}) {
  const locals = []
  const records = []
  let offset = 0
  for (const e of entries) {
    const name = e.rawName || Buffer.from(e.name, 'utf8')
    const data = e.data ? Buffer.from(e.data) : Buffer.alloc(0)
    const method = e.method === undefined ? 0 : e.method
    let packed = method === 8 ? zlib.deflateRawSync(data) : data
    // Traditional ZIP encryption puts a 12-byte header in front of the data.
    if (e.encrypted) packed = Buffer.concat([crypto.randomBytes(12), packed])
    const crc = zlib.crc32(data)
    const flags = (e.encrypted ? 1 : 0) | (e.rawName ? 0 : 0x800)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc >>> 0, 14)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, packed)
    records.push({ name, method, crc, packed: packed.length, size: data.length, flags, offset, symlink: e.symlink, dir: e.dir, comment: e.comment || Buffer.alloc(0) })
    offset += 30 + name.length + packed.length
  }
  if (overlap) records.push({ ...records[0], name: Buffer.from('copia-' + records[0].name.toString()) })
  const centrals = []
  for (const r of records) {
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0)
    c.writeUInt16LE(0x0314, 4) // made by unix
    c.writeUInt16LE(20, 6)
    c.writeUInt16LE(r.flags, 8)
    c.writeUInt16LE(r.method, 10)
    c.writeUInt32LE(r.crc >>> 0, 16)
    c.writeUInt32LE(r.packed, 20)
    c.writeUInt32LE(r.size, 24)
    c.writeUInt16LE(r.name.length, 28)
    c.writeUInt16LE(r.comment.length, 32)
    const mode = r.symlink ? 0o120777 : r.dir ? 0o40755 : 0o100644
    c.writeUInt32LE(((mode << 16) | (r.dir ? 0x10 : 0)) >>> 0, 38)
    c.writeUInt32LE(r.offset, 42)
    centrals.push(c, r.name, r.comment)
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(records.length, 8)
  end.writeUInt16LE(records.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}

// ----------------------------------------------------------- calibration

// The band levels (C[0..39], dB under the 1-8 kHz band) of real files, with the
// cutoff each gives: the unit tests check the rule on them, the real-tool test
// measures the files again. From Hey Ray "Kokoro" track 02 (genuine) and its
// encodes (lame128, lame320, opus128, aacFromMp3: its LAME 192 made AAC 256),
// track 04 (dithered16k), senza-dati/traccia01 (yoru320), NEA 06 (nea06);
// `natural` is made up (a steep roll-off that is no cut).
export const CALIBRATION_VECTORS = {
  lame128: [17000, [-11.0, -12.2, -12.9, -12.8, -12.4, -13.3, -13.5, -14.3, -14.2, -14.0, -13.9, -14.3, -15.0, -15.3, -15.6, -16.1, -16.9, -17.6, -17.3, -18.7, -18.7, -20.0, -19.0, -21.1, -22.2, -22.5, -22.9, -24.1, -24.6, -35.3, -93.2, -99.1, -102.1, -107.4, -97.9, -108.2, -107.7, -98.4, -107.4, -99.7]],
  dithered16k: [16000, [-10.4, -11.2, -14.6, -19.4, -21.0, -22.5, -25.2, -23.8, -26.4, -29.5, -25.2, -26.9, -30.1, -26.1, -27.3, -24.2, -28.1, -26.3, -24.5, -24.5, -26.1, -30.7, -32.3, -28.3, -28.7, -28.0, -32.8, -36.1, -47.6, -54.0, -60.1, -59.5, -59.9, -60.3, -60.2, -60.1, -59.7, -59.7, -60.1, -60.2]],
  aacFromMp3: [19000, [-11.0, -12.3, -13.0, -12.8, -12.5, -13.3, -13.6, -14.4, -14.4, -14.2, -14.1, -14.4, -15.1, -15.4, -15.8, -16.3, -17.3, -18.1, -17.6, -19.2, -19.1, -20.4, -19.4, -21.6, -22.9, -23.3, -23.6, -24.0, -23.8, -24.1, -24.2, -24.6, -25.1, -33.1, -49.1, -59.1, -61.8, -63.2, -65.2, -68.4]],
  yoru320: [14500, [-8.3, -9.7, -9.6, -12.1, -13.3, -13.2, -16.8, -19.3, -19.9, -20.2, -20.4, -20.0, -19.3, -19.1, -18.6, -19.1, -19.4, -20.5, -22.0, -23.4, -24.7, -26.0, -27.7, -29.0, -32.2, -69.2, -77.3, -82.1, -86.8, -96.8, -110.7, -104.8, -107.8, -110.7, -104.3, -111.3, -110.8, -103.9, -110.8, -104.0]],
  genuine: [null, [-11.0, -12.3, -12.9, -12.8, -12.5, -13.3, -13.6, -14.4, -14.4, -14.2, -14.1, -14.5, -15.1, -15.5, -15.8, -16.4, -17.3, -18.1, -17.6, -19.3, -19.1, -20.5, -19.4, -21.6, -23.0, -23.4, -23.6, -24.2, -23.8, -24.3, -24.2, -24.7, -25.2, -26.5, -27.1, -28.5, -31.4, -36.2, -46.6, -59.9]],
  lame320: [null, [-11.0, -12.3, -12.9, -12.8, -12.5, -13.3, -13.6, -14.4, -14.3, -14.2, -14.1, -14.5, -15.1, -15.5, -15.8, -16.4, -17.3, -18.1, -17.6, -19.3, -19.1, -20.5, -19.4, -21.6, -22.9, -23.3, -23.6, -24.2, -23.8, -24.2, -24.2, -24.7, -25.2, -26.4, -27.1, -28.6, -43.7, -98.0, -107.3, -99.6]],
  opus128: [null, [-11.0, -12.3, -12.9, -12.8, -12.5, -13.3, -13.6, -14.4, -14.3, -14.2, -14.1, -14.4, -15.2, -15.4, -15.8, -16.3, -17.3, -18.1, -17.6, -19.2, -19.1, -20.5, -19.4, -21.6, -22.9, -23.3, -23.6, -24.5, -24.3, -24.2, -24.2, -24.6, -25.1, -26.0, -26.8, -28.1, -44.8, -79.7, -94.6, -104.9]],
  nea06: [null, [-9.7, -11.7, -12.2, -11.9, -13.8, -18.7, -18.0, -18.4, -19.2, -19.6, -19.1, -18.8, -19.6, -19.9, -19.6, -20.2, -20.7, -21.7, -22.5, -24.2, -25.1, -25.8, -26.6, -27.3, -28.2, -28.6, -29.3, -29.7, -30.7, -31.3, -32.0, -33.1, -34.3, -36.3, -39.4, -42.8, -48.7, -59.4, -72.4, -78.8]],
  natural: [null, [...Array(28).fill(-20), -30, -37, -45, -53, -60, -66, -71, -75, -78, -80, -82, -83]]
}

/** <dir>/<tree>/<ab>/<name>: where a track file or a transcode lives (256 shards). */
export function shardPath (dir, tree, name) {
  return path.join(dir, tree, name.slice(0, 2), name)
}

/** The file names of <dir>/<tree>, across its shards (and any left at its top). */
export function treeFiles (dir, tree) {
  const top = path.join(dir, tree)
  const out = []
  let names = []
  try { names = fs.readdirSync(top) } catch { return out }
  for (const name of names) {
    if (/^[0-9a-f]{2}$/.test(name)) {
      for (const f of fs.readdirSync(path.join(top, name))) out.push(f)
    } else {
      out.push(name)
    }
  }
  return out.sort()
}
