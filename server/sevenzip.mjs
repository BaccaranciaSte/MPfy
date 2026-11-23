// 7-Zip for 7z and RAR archives (ZIP always goes through yauzl, zip.mjs).
//
// Only 7-Zip 25.01 or later is used: older builds have the RAR5 heap overflow and
// the link traversal bugs, and the tool runs with the server's uid. The command is
// MPFY_7Z, else the first of `7zz`, `7z` whose `i` passes; RAR only when the
// `Codecs:` section lists Rar5. Every run goes under `nice -n 19` and, on Linux,
// `prlimit --as=<MPFY_7Z_MEM_BYTES> --fsize=629145600` with MALLOC_ARENA_MAX=2.
//
// Listing (`l -slt`) is parsed as a stream and judged before anything is
// extracted; extraction (`e`, flat, into a fresh dir) runs detached under a
// watchdog that kills the whole group when the dir grows past the declared total.

import fs from 'node:fs'
import path from 'node:path'
import { ToolRunner } from './tools.mjs'
import { ArchiveError } from './errors.mjs'

export const DEFAULT_MEM_BYTES = 536870912
const FSIZE = 629145600
const LIST_TIMEOUT = 60000
const EXTRACT_TIMEOUT = 60 * 60 * 1000
const MAX_LIST_OUTPUT = 4 * 1024 * 1024
const WATCH_EVERY = 500

export const LIMITS = {
  entries: 1000,
  entryBytes: 600 * 1024 * 1024,
  totalBytes: 6442450944,
  ratioEntryMin: 10 * 1024 * 1024,
  ratioTotalMin: 100 * 1024 * 1024,
  ratio: 50
}

// --------------------------------------------------------------- probe

/**
 * `7zz i` output: { version: [major, minor] | null, text, rar: boolean }; `text`
 * is the version as 7-Zip prints it ("26.06": the minor keeps its zero).
 */
export function parseInfo (stdout) {
  const lines = String(stdout).split(/\r?\n/)
  const first = lines.find((l) => l.trim() !== '') || ''
  const m = /^\s*7-Zip\b.*?\b(\d+)\.(\d+)\b/.exec(first)
  const version = m ? [Number(m[1]), Number(m[2])] : null
  const text = m ? m[1] + '.' + m[2] : null
  let rar = false
  let inCodecs = false
  for (const raw of lines) {
    const line = raw.trim()
    if (/^[A-Za-z][A-Za-z ]*:$/.test(line)) {
      inCodecs = line === 'Codecs:'
      continue
    }
    if (inCodecs && line !== '') {
      const tokens = line.split(/\s+/)
      if (tokens[tokens.length - 1] === 'Rar5') rar = true
    }
  }
  return { version, text, rar }
}

export function versionUsable (version) {
  if (!version) return false
  const [major, minor] = version
  return major > 25 || (major === 25 && minor >= 1)
}

export class SevenZip {
  /**
   * @param {object} opts
   * @param {string|null} [opts.command]  MPFY_7Z; null: try 7zz then 7z
   * @param {number} [opts.memBytes]  the prlimit cap
   * @param {string[]} [opts.candidates]
   */
  constructor ({ command = null, memBytes = DEFAULT_MEM_BYTES, candidates = ['7zz', '7z'], nice } = {}) {
    this.candidates = command ? [command] : candidates
    this.memBytes = memBytes
    this.nice = nice
    this.runner = null
    this.available = false
    this.rar = false
    this.version = null
    this.command = null
  }

  async probe () {
    for (const command of this.candidates) {
      const runner = this._runner(command)
      let out
      try {
        out = (await runner.run(['i'], { lowPriority: false, stdout: true, timeoutMs: 15000, quiet: true })).stdout
      } catch {
        continue
      }
      const info = parseInfo(out)
      if (!versionUsable(info.version)) continue
      this.runner = runner
      this.command = command
      this.available = true
      this.rar = info.rar
      this.version = info.text
      return true
    }
    return false
  }

  _runner (command) {
    const opts = { command, label: '7-Zip', limits: ['--as=' + this.memBytes, '--fsize=' + FSIZE], env: { MALLOC_ARENA_MAX: '2' } }
    if (this.nice !== undefined) opts.nice = this.nice
    return new ToolRunner(opts)
  }

  /** Can this archive kind (7z or rar) be opened here? */
  supports (kind) {
    if (kind === '7z') return this.available
    if (kind === 'rar') return this.available && this.rar
    return false
  }

  /** List an archive: the raw listing (see ListParser). */
  async list (file) {
    const parser = new ListParser()
    const t = this.runner.spawnTool(['l', '-slt', '-sccUTF-8', '-pmpfy', '--', file])
    if (t.child === null) throw new ArchiveError('archive_invalid')
    let stderr = ''
    t.child.stdout.on('data', (d) => {
      if (!parser.push(d)) t.kill()
    })
    t.child.stderr.on('data', (d) => {
      if (stderr.length < 65536) stderr += d.toString('utf8')
    })
    const timer = setTimeout(() => {
      parser.timedOut = true
      t.kill()
    }, LIST_TIMEOUT)
    const { code } = await t.done
    clearTimeout(timer)
    parser.end()
    return parser.result(code, stderr)
  }

  /**
   * Extract flat into `dir` (fresh, empty). `total` is the listed size: the
   * watchdog kills the group past total x 1.05 + 1 MiB, or after 60 minutes.
   */
  async extract (file, dir, total, { watchEvery = WATCH_EVERY, maxMs = EXTRACT_TIMEOUT } = {}) {
    const t = this.runner.spawnTool(['e', '-y', '-aou', '-bd', '-bso0', '-bsp0', '-sccUTF-8', '-pmpfy', '-o' + dir, '--', file], { detached: true, stdout: 'ignore', stderr: 'ignore' })
    if (t.child === null) throw new ArchiveError('archive_invalid')
    const watch = watchdog(dir, total, t.kill, { watchEvery, maxMs })
    const { code } = await t.done
    watch.stop()
    if (watch.tripped) throw new ArchiveError('archive_invalid')
    if (code === 0 || code === 1) return code
    if (code === 8) throw new ArchiveError('archive_too_big')
    throw new ArchiveError('archive_invalid')
  }
}

/** Sum of the regular files' sizes in a dir (not recursive: extraction is flat). */
export function dirBytes (dir) {
  let sum = 0
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return 0
  }
  for (const name of names) {
    try {
      const st = fs.lstatSync(path.join(dir, name))
      if (st.isFile()) sum += st.size
      else if (st.isDirectory()) sum += dirBytes(path.join(dir, name))
    } catch {}
  }
  return sum
}

/**
 * Every `watchEvery` ms: the dir above total x 1.05 + 1 MiB, or `maxMs` elapsed,
 * calls kill() once. `bytes` overrides the measure (a stream that counts itself).
 */
export function watchdog (dir, total, kill, { watchEvery = WATCH_EVERY, maxMs = EXTRACT_TIMEOUT, bytes = null } = {}) {
  const limit = total * 1.05 + 1024 * 1024
  const started = Date.now()
  const state = { tripped: false, stop: () => clearInterval(timer) }
  const timer = setInterval(() => {
    const used = bytes ? bytes() : dirBytes(dir)
    if (used > limit || Date.now() - started > maxMs) {
      state.tripped = true
      clearInterval(timer)
      kill()
    }
  }, watchEvery)
  return state
}

// -------------------------------------------------------------- listing

/**
 * Streamed parser of `7z l -slt`. push() returns false when 7-Zip must be
 * killed (the 1001st file block, or more than 4 MiB of output).
 */
export class ListParser {
  constructor () {
    this.bytes = 0
    this.partial = ''
    this.inEntries = false
    this.type = null
    this.block = null
    this.entries = []
    this.files = 0
    this.tooBig = false
    this.timedOut = false
    this.text = '' // a short tail, for the encrypted-archive messages
  }

  push (chunk) {
    if (this.tooBig) return false
    this.bytes += chunk.length
    if (this.bytes > MAX_LIST_OUTPUT) {
      this.tooBig = true
      return false
    }
    const s = this.partial + chunk.toString('utf8')
    this.text = (this.text + s).slice(-4096)
    const lines = s.split(/\r?\n/)
    this.partial = lines.pop()
    for (const line of lines) {
      this._line(line)
      if (this.tooBig) return false
    }
    return true
  }

  end () {
    if (this.partial !== '' && !this.tooBig) this._line(this.partial)
    this.partial = ''
    this._closeBlock()
  }

  _line (line) {
    if (!this.inEntries) {
      if (/^-{10,}$/.test(line.trim())) {
        this.inEntries = true
        return
      }
      const m = /^Type = (.*)$/.exec(line)
      if (m && this.type === null) this.type = m[1].trim()
      return
    }
    if (line.trim() === '') {
      this._closeBlock()
      return
    }
    const i = line.indexOf(' = ')
    let key
    let value
    if (i === -1) {
      if (!/ =$/.test(line)) return
      key = line.slice(0, -2)
      value = ''
    } else {
      key = line.slice(0, i)
      value = line.slice(i + 3)
    }
    if (this.block === null) this.block = {}
    this.block[key] = value
  }

  _closeBlock () {
    const b = this.block
    this.block = null
    if (!b || b.Path === undefined) return
    // 7z listings have no Folder line: there a directory is told by its
    // attributes (D, or a unix mode starting with d), and only when it holds no
    // bytes: 7-Zip extracts an entry with data as a file whatever they say.
    const size = toNumber(b.Size)
    const packed = toNumber(b['Packed Size'])
    const folder = b.Folder !== undefined ? b.Folder === '+' : isDirAttributes(b.Attributes) && !(size > 0) && !(packed > 0)
    if (!folder) {
      this.files++
      if (this.files > LIMITS.entries) {
        this.tooBig = true
        return
      }
    }
    this.entries.push({
      path: b.Path,
      folder,
      size,
      packed,
      attributes: b.Attributes || '',
      encrypted: b.Encrypted === '+',
      symlink: b['Symbolic Link'] || '',
      hardlink: b['Hard Link'] || ''
    })
  }

  result (code, stderr = '') {
    return { type: this.type, entries: this.entries, code, tooBig: this.tooBig, timedOut: this.timedOut, text: this.text, stderr }
  }
}

function isDirAttributes (attributes) {
  const tokens = String(attributes || '').trim().split(/\s+/)
  return /D/.test(tokens[0] || '') || tokens.some((t) => /^d[-rwxsStT]{9}$/.test(t))
}

function toNumber (v) {
  if (v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Absolute (/, \, X:) or with a .. component. */
export function unsafePath (p) {
  if (/^[\\/]/.test(p) || /^[A-Za-z]:/.test(p)) return true
  return p.split(/[\\/]/).some((part) => part === '..')
}

function unixLink (attributes) {
  return String(attributes).split(/\s+/).some((t) => /^l[-rwxsStT]{9}$/.test(t))
}

/**
 * Judge a listing: throws ArchiveError, or returns { total, files } where files are
 * the file entries in listing order. `archiveSize` is the archive's own size.
 */
export function judgeListing (listing, archiveSize) {
  const blob = listing.text + '\n' + listing.stderr
  if (listing.tooBig) throw new ArchiveError('archive_too_big')
  if (listing.entries.some((e) => e.encrypted) || /Wrong password|Can not open encrypted archive/.test(blob)) {
    throw new ArchiveError('archive_encrypted')
  }
  if (listing.timedOut) throw new ArchiveError('archive_invalid')
  if (listing.code === 8) throw new ArchiveError('archive_too_big')
  if (listing.code !== 0) throw new ArchiveError('archive_invalid')
  if (!['7z', 'Rar', 'Rar5'].includes(listing.type)) throw new ArchiveError('unsupported_archive')
  for (const e of listing.entries) {
    if (unsafePath(e.path) || e.symlink !== '' || e.hardlink !== '' || unixLink(e.attributes)) throw new ArchiveError('archive_invalid')
  }
  const files = listing.entries.filter((e) => !e.folder)
  return judgeSizes(files.map((e) => ({ name: e.path, size: e.size || 0, packed: e.packed })), archiveSize)
}

/** The size and ratio rules shared by 7-Zip and ZIP listings. */
export function judgeSizes (files, archiveSize) {
  if (files.length > LIMITS.entries) throw new ArchiveError('archive_too_big')
  let total = 0
  for (const f of files) {
    if (f.size > LIMITS.entryBytes) throw new ArchiveError('archive_too_big')
    total += f.size
  }
  if (total > LIMITS.totalBytes) throw new ArchiveError('archive_too_big')
  for (const f of files) {
    // Solid archives list no packed size for most entries: only a known one counts.
    if (f.size >= LIMITS.ratioEntryMin && f.packed > 0 && f.size / f.packed > LIMITS.ratio) {
      throw new ArchiveError('archive_invalid')
    }
  }
  if (total >= LIMITS.ratioTotalMin && total / Math.max(1, archiveSize) > LIMITS.ratio) throw new ArchiveError('archive_invalid')
  return { total, files }
}
