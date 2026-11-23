// Static files of the UI (webRoot), for every path that is neither /local/* nor
// /s/*. Paths are decoded and confined to webRoot (no '..', no hidden files, no
// backslashes, no drive letters or stream names). A path that names no file falls
// back to index.html (the UI routes by history: /library, /album/<id>, ...),
// except when its last segment has a file extension: a missing /js/x.js is a 404,
// not an HTML page under a script's name.
//
// Every answer carries Cache-Control: no-cache and a weak ETag from the size and
// the modification time, so an app update (a new webRoot) is seen at once while
// unchanged files cost a 304.
//
// Portable: '#fs' and '#path' import maps.

import fs from '#fs'
import path from '#path'

export const MAX_STATIC_BYTES = 32 * 1024 * 1024

const MIME = {
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
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.wasm': 'application/wasm'
}

export function mimeType (file) {
  const ext = path.extname(file).toLowerCase()
  return MIME[ext] || 'application/octet-stream'
}

export function etagOf (stat) {
  return 'W/"' + stat.size.toString(16) + '-' + Math.floor(stat.mtimeMs).toString(16) + '"'
}

export class StaticFiles {
  constructor (root) {
    this.root = path.resolve(root)
  }

  /**
   * The file to serve for a request path (still percent-encoded, no query).
   * @returns {Promise<{ file: string, stat: object, fallback: boolean } | null>}
   *   null: 404
   */
  async resolve (urlPath) {
    let decoded
    try {
      decoded = decodeURIComponent(urlPath)
    } catch {
      return null
    }
    if (decoded.includes('\0') || decoded.includes('\\')) return null
    const segments = decoded.split('/').filter((s) => s !== '')
    if (segments.some((s) => s.startsWith('.') || s.includes(':'))) return null

    const index = path.join(this.root, 'index.html')
    let file = segments.length === 0 ? index : path.join(this.root, ...segments)
    if (file !== this.root && !file.startsWith(this.root + path.sep)) return null

    let stat = await statOrNull(file)
    if (stat !== null && stat.isDirectory()) {
      file = path.join(file, 'index.html')
      stat = await statOrNull(file)
    }
    if (stat !== null && stat.isFile()) return { file, stat, fallback: false }

    const last = segments.length > 0 ? segments[segments.length - 1] : ''
    if (/\.[A-Za-z0-9]{1,12}$/.test(last)) return null
    stat = await statOrNull(index)
    if (stat === null || !stat.isFile()) return null
    return { file: index, stat, fallback: true }
  }

  async read (file) {
    return fs.promises.readFile(file)
  }
}

async function statOrNull (file) {
  try {
    return await fs.promises.stat(file)
  } catch {
    return null
  }
}
