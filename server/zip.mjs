// Every ZIP goes through yauzl (memory-safe JS), with or without 7-Zip.
//
// First pass: the whole central directory, judged before anything is
// extracted: encrypted entries, symlinks, yauzl's own name checks, counts, sizes,
// both ratio rules, overlapping entries (a classic zip bomb trick) and
// compression methods yauzl cannot read. An entry spans from its local header to
// the end of its data, as the local header says where the data starts: 7-Zip
// and others put extra fields in the central directory that the local header
// does not have, so the central lengths alone would see overlaps in every
// ordinary archive. Second pass: each file entry streamed to
// tmp/x-<id>/<n>.bin (a counter, never its name) under the same watchdog as
// 7-Zip; yauzl checks every entry's real size against the declared one.
//
// yauzl leaves names and comments as bytes: decoding them itself it builds each
// non-UTF-8 string one character at a time, about 2 MB of heap for a 64 KB
// comment, kept for every entry. Names are decoded here, checked as yauzl checks
// them, capped in length; comments and extra fields are dropped.

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import yauzl from 'yauzl'
import { ArchiveError } from './errors.mjs'
import { LIMITS, judgeSizes, watchdog } from './sevenzip.mjs'

const S_IFMT = 0o170000
const S_IFLNK = 0o120000
export const MAX_NAME_BYTES = 1024
// Code page 437, bytes 0x80..0xff: the names of ZIPs without the UTF-8 flag.
const CP437_HIGH =
  '\u00c7\u00fc\u00e9\u00e2\u00e4\u00e0\u00e5\u00e7\u00ea\u00eb\u00e8\u00ef\u00ee\u00ec\u00c4\u00c5' +
  '\u00c9\u00e6\u00c6\u00f4\u00f6\u00f2\u00fb\u00f9\u00ff\u00d6\u00dc\u00a2\u00a3\u00a5\u20a7\u0192' +
  '\u00e1\u00ed\u00f3\u00fa\u00f1\u00d1\u00aa\u00ba\u00bf\u2310\u00ac\u00bd\u00bc\u00a1\u00ab\u00bb' +
  '\u2591\u2592\u2593\u2502\u2524\u2561\u2562\u2556\u2555\u2563\u2551\u2557\u255d\u255c\u255b\u2510' +
  '\u2514\u2534\u252c\u251c\u2500\u253c\u255e\u255f\u255a\u2554\u2569\u2566\u2560\u2550\u256c\u2567' +
  '\u2568\u2564\u2565\u2559\u2558\u2552\u2553\u256b\u256a\u2518\u250c\u2588\u2584\u258c\u2590\u2580' +
  '\u03b1\u00df\u0393\u03c0\u03a3\u03c3\u00b5\u03c4\u03a6\u0398\u03a9\u03b4\u221e\u03c6\u03b5\u2229' +
  '\u2261\u00b1\u2265\u2264\u2320\u2321\u00f7\u2248\u00b0\u2219\u00b7\u221a\u207f\u00b2\u25a0\u00a0'

function openZip (file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false, decodeStrings: false, validateEntrySizes: true }, (err, zipfile) => {
      if (err) reject(new ArchiveError('archive_invalid'))
      else resolve(zipfile)
    })
  })
}

function cp437 (buf) {
  let out = ''
  for (let i = 0; i < buf.length; i += 4096) {
    out += Array.from(buf.subarray(i, i + 4096), (b) => (b < 0x80 ? String.fromCharCode(b) : CP437_HIGH[b - 0x80])).join('')
  }
  return out
}

/**
 * An entry's name as yauzl would read it with strictFileNames (the Info-ZIP
 * Unicode path when its CRC matches, else UTF-8 by the flag, else code page
 * 437), or null when it is too long or not a safe relative name.
 */
export function entryName (entry) {
  const raw = entry.fileNameRaw
  if (raw.length > MAX_NAME_BYTES) return null
  let name = null
  for (const f of entry.extraFields) {
    if (f.id !== 0x7075 || f.data.length < 6 || f.data[0] !== 1) continue
    if (zlib.crc32(raw) !== f.data.readUInt32LE(1)) continue
    if (f.data.length - 5 > MAX_NAME_BYTES) return null
    name = f.data.subarray(5).toString('utf8')
    break
  }
  if (name === null) name = (entry.generalPurposeBitFlag & 0x800) !== 0 ? raw.toString('utf8') : cp437(raw)
  return yauzl.validateFileName(name) === null ? name : null
}

function readAll (zipfile) {
  return new Promise((resolve, reject) => {
    const entries = []
    zipfile.on('entry', (entry) => {
      const name = entryName(entry)
      if (name === null) {
        reject(new ArchiveError('archive_invalid'))
        return
      }
      // Only what the checks and the second pass read stays (the raw buffers hold
      // the name, the extra fields and the comment together).
      entry.fileName = name
      for (const k of ['fileNameRaw', 'extraFieldRaw', 'fileCommentRaw', 'fileComment', 'comment', 'extraFields']) delete entry[k]
      entries.push(entry)
      zipfile.readEntry()
    })
    zipfile.on('end', () => resolve(entries))
    zipfile.on('error', () => reject(new ArchiveError('archive_invalid')))
    zipfile.readEntry()
  })
}

function dataStart (zipfile, entry) {
  return new Promise((resolve, reject) => {
    zipfile.readLocalFileHeader(entry, { minimal: true }, (err, h) => (err ? reject(new ArchiveError('archive_invalid')) : resolve(h.fileDataStart)))
  })
}

/**
 * The checks of the first pass; returns { total, files } (files: yauzl
 * entries). `starts[i]` is where entry i's data begins (its local header).
 */
export function judgeZipEntries (entries, archiveSize, starts = null) {
  const ranges = []
  const files = []
  for (const [i, e] of entries.entries()) {
    if ((e.generalPurposeBitFlag & 1) !== 0) throw new ArchiveError('archive_encrypted')
    if (((e.externalFileAttributes >>> 16) & S_IFMT) === S_IFLNK) throw new ArchiveError('archive_invalid')
    const start = starts !== null ? starts[i] : e.relativeOffsetOfLocalHeader + 30 + e.fileNameLength + e.extraFieldLength
    ranges.push([e.relativeOffsetOfLocalHeader, start + e.compressedSize])
    if (e.fileName.endsWith('/')) continue
    if (e.compressionMethod !== 0 && e.compressionMethod !== 8) throw new ArchiveError('archive_invalid')
    files.push(e)
  }
  ranges.sort((a, b) => a[0] - b[0])
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i][0] < ranges[i - 1][1]) throw new ArchiveError('archive_invalid')
  }
  const judged = judgeSizes(files.map((e) => ({ name: e.fileName, size: e.uncompressedSize, packed: Math.max(1, e.compressedSize) })), archiveSize)
  return { total: judged.total, files }
}

export class ZipArchive {
  constructor (file) {
    this.file = file
    this.zipfile = null
    this.files = []
    this.total = 0
  }

  /** Open and judge the central directory. Throws ArchiveError. */
  async check () {
    const archiveSize = fs.statSync(this.file).size
    this.zipfile = await openZip(this.file)
    if (this.zipfile.entryCount > LIMITS.entries) throw new ArchiveError('archive_too_big')
    const entries = await readAll(this.zipfile)
    for (const e of entries) {
      if ((e.generalPurposeBitFlag & 1) !== 0) throw new ArchiveError('archive_encrypted')
    }
    const starts = []
    for (const e of entries) starts.push(await dataStart(this.zipfile, e))
    const { total, files } = judgeZipEntries(entries, archiveSize, starts)
    this.total = total
    this.files = files
    return { total, names: files.map((e) => e.fileName) }
  }

  /**
   * Stream every file entry to dir/<n>.bin, in listing order. Returns
   * [{ name, file }] (the name stays in memory for the title and the cover).
   */
  async extract (dir, { watchEvery, maxMs } = {}) {
    let written = 0
    let stop = null
    const watch = watchdog(dir, this.total, () => { if (stop) stop() }, { watchEvery, maxMs, bytes: () => written })
    const out = []
    try {
      for (let n = 0; n < this.files.length; n++) {
        if (watch.tripped) throw new ArchiveError('archive_invalid')
        const entry = this.files[n]
        const dest = path.join(dir, n + '.bin')
        const stream = await new Promise((resolve, reject) => {
          this.zipfile.openReadStream(entry, (err, s) => (err ? reject(new ArchiveError('archive_invalid')) : resolve(s)))
        })
        const counter = new Transform({
          transform (chunk, enc, cb) {
            written += chunk.length
            cb(null, chunk)
          }
        })
        stop = () => counter.destroy(new ArchiveError('archive_invalid'))
        try {
          await pipeline(stream, counter, fs.createWriteStream(dest, { flags: 'wx', mode: 0o600 }))
        } catch (err) {
          if (err && err.code === 'ENOSPC') throw new ArchiveError('disk_full')
          throw new ArchiveError('archive_invalid')
        }
        out.push({ name: entry.fileName, file: dest })
      }
      if (watch.tripped) throw new ArchiveError('archive_invalid')
      return out
    } finally {
      watch.stop()
    }
  }

  close () {
    if (this.zipfile !== null) {
      try { this.zipfile.close() } catch {}
      this.zipfile = null
    }
  }
}
