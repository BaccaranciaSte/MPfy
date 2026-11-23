// Static files of web/ with SPA fallback.
//
// Request paths are never joined into filesystem paths: the web directory is walked
// into a map "/relative/path" -> absolute path, and a request is served only if its
// decoded path is a key of that map. On a miss the map is rebuilt (at most every
// 2 s), so files added while the server runs (UI development) appear by themselves.
// All web files get "Cache-Control: no-cache" plus an ETag, and text files are
// gzipped once per version and kept in memory.

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { promisify } from 'node:util'
import { pipeline } from 'node:stream/promises'

const gzip = promisify(zlib.gzip)

const RESCAN_GAP = 2000
const MAX_FILES = 5000
const MAX_DEPTH = 8
const GZIP_MIN = 1024
const GZIP_CACHE_MAX = 32 * 1024 * 1024

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
}
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.map', '.webmanifest', '.txt', '.svg'])

export class StaticFiles {
  constructor (webDir) {
    this.root = path.resolve(webDir)
    this._files = new Map()
    this._lastScan = 0
    this._gzipCache = new Map() // abs path -> { key, data }
    this._gzipBytes = 0
    this._scan()
  }

  _scan () {
    const files = new Map()
    const walk = (dir, rel, depth) => {
      if (depth > MAX_DEPTH || files.size >= MAX_FILES) return
      let entries
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue // no dotfiles
        const abs = path.join(dir, e.name)
        const key = rel + '/' + e.name
        if (e.isDirectory()) walk(abs, key, depth + 1)
        else if (e.isFile()) files.set(key, abs)
        if (files.size >= MAX_FILES) return
      }
    }
    walk(this.root, '', 0)
    this._files = files
    this._lastScan = Date.now()
  }

  /** Absolute path for a decoded request path, or null. */
  lookup (decodedPath) {
    const key = decodedPath === '/' ? '/index.html' : decodedPath
    let file = this._files.get(key)
    if (file === undefined && Date.now() - this._lastScan > RESCAN_GAP) {
      this._scan()
      file = this._files.get(key)
    }
    return file === undefined ? null : file
  }

  /**
   * Serve `decodedPath`, or index.html when it is unknown (SPA routes).
   * @returns {Promise<boolean>} false when not even index.html exists
   */
  async serve (req, res, decodedPath) {
    let file = this.lookup(decodedPath)
    if (file === null) file = this.lookup('/index.html')
    if (file === null) return false

    let st
    try {
      st = await fs.promises.stat(file)
    } catch {
      this._lastScan = 0 // the map is stale
      return false
    }
    const ext = path.extname(file).toLowerCase()
    const type = TYPES[ext] || 'application/octet-stream'
    const tag = 'W/"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"'

    res.setHeader('Content-Type', type)
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('ETag', tag)
    res.setHeader('Vary', 'Accept-Encoding')
    if (ext === '.html') res.setHeader('Content-Security-Policy', "frame-ancestors 'none'")

    if (etagMatches(req.headers['if-none-match'], tag)) {
      res.statusCode = 304
      res.end()
      return true
    }

    if (COMPRESSIBLE.has(ext) && st.size >= GZIP_MIN && acceptsGzip(req)) {
      const data = await this._gzipped(file, st)
      res.statusCode = 200
      res.setHeader('Content-Encoding', 'gzip')
      res.setHeader('Content-Length', data.length)
      res.end(req.method === 'HEAD' ? undefined : data)
      return true
    }

    res.statusCode = 200
    res.setHeader('Content-Length', st.size)
    if (req.method === 'HEAD') {
      res.end()
      return true
    }
    // pipeline closes the file if the client goes away mid-transfer.
    pipeline(fs.createReadStream(file), res).catch(() => {})
    return true
  }

  async _gzipped (file, st) {
    const key = st.size + ':' + st.mtimeMs
    const hit = this._gzipCache.get(file)
    if (hit && hit.key === key) return hit.data
    const data = await gzip(await fs.promises.readFile(file), { level: 9 })
    if (hit) this._gzipBytes -= hit.data.length
    if (this._gzipBytes + data.length > GZIP_CACHE_MAX) {
      this._gzipCache.clear()
      this._gzipBytes = 0
    }
    this._gzipCache.set(file, { key, data })
    this._gzipBytes += data.length
    return data
  }
}

export function acceptsGzip (req) {
  const ae = req.headers['accept-encoding']
  if (typeof ae !== 'string') return false
  return ae.split(',').some((part) => {
    const [coding, ...params] = part.trim().toLowerCase().split(';')
    if (coding.trim() !== 'gzip') return false
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='))
    return q === undefined || Number(q.slice(2)) > 0
  })
}

/** If-None-Match comparison (weak, as RFC 9110 requires for this header). */
export function etagMatches (header, tag) {
  if (typeof header !== 'string') return false
  const bare = (t) => t.trim().replace(/^W\//, '')
  const want = bare(tag)
  return header.split(',').some((t) => t.trim() === '*' || bare(t) === want)
}
