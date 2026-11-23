// Minimal HTTP/1.1 pieces of the client core. There is no 'http' module on Bare
// (the Android worklet), so the core reads request heads itself:
//
// - findHeadEnd / parseRequestHead: a strict request-head parser (origin-form
//   targets only, no obs-fold, no whitespace before a colon, one Host, framing
//   rules of RFC 9112 6.3: Transfer-Encoding and Content-Length together are an
//   error, so a body is never read two ways by two parsers).
// - ChunkedDecoder: the chunked body of the few requests the core answers itself
//   (/local/*); forwarded bodies are passed through untouched.
// - buildForwardHead: the head sent to a source for /s/<id>/<rest>.
// - responseHead: the head of a response the core writes itself.
//
// Portable: b4a only.

import b4a from 'b4a'

export const MAX_HEAD_BYTES = 32 * 1024
export const MAX_HEADERS = 100
// What a source's HTTP API is told it is: the port it listens on.
export const SOURCE_HOST = '127.0.0.1:8091'

export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message  Italian, shown as `error`
   * @param {string|null} [code]  a stable id the page maps to its own words
   * @param {object|null} [extra]  more fields of the answer (triesLeft, retryAt)
   */
  constructor (status, message, code = null, extra = null) {
    super(message)
    this.status = status
    this.code = code
    this.extra = extra
  }
}

export const STATUS_TEXT = {
  100: 'Continue',
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  304: 'Not Modified',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  408: 'Request Timeout',
  409: 'Conflict',
  413: 'Content Too Large',
  429: 'Too Many Requests',
  431: 'Request Header Fields Too Large',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
  505: 'HTTP Version Not Supported'
}

const TOKEN_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
// origin-form: an absolute path and an optional query, visible ASCII, no '#'.
const TARGET_RE = /^\/[\x21\x22\x24-\x7e]*$/
// Field values: visible ASCII, obs-text, SP and HTAB; no other control character.
const BAD_VALUE_RE = /[\x00-\x08\x0a-\x1f\x7f]/

const BAD_REQUEST = 'Richiesta non valida'

/**
 * Where the head ends in `buf`. Leading empty lines are skipped (RFC 9112 2.2).
 * A line ends with LF, optionally preceded by CR.
 * @param {Uint8Array} buf
 * @param {number} [from=0]  where to resume the search (bytes before it were
 *   already searched; pass the previous length minus 3)
 * @returns {{ start: number, end: number }} end is -1 while the head is incomplete
 */
export function findHeadEnd (buf, from = 0) {
  const len = buf.byteLength
  let start = 0
  while (start < len && (buf[start] === 13 || buf[start] === 10)) start++
  for (let i = Math.max(from, start); i < len; i++) {
    if (buf[i] !== 10) continue
    if (i + 1 < len && buf[i + 1] === 10) return { start, end: i + 2 }
    if (i + 2 < len && buf[i + 1] === 13 && buf[i + 2] === 10) return { start, end: i + 3 }
  }
  return { start, end: -1 }
}

/**
 * Parse a complete request head (bytes start..end of buf, as found by findHeadEnd).
 * Throws HttpError (400, 431, 501, 505) on anything malformed or unsupported.
 *
 * @returns {{
 *   method: string, target: string, path: string, query: string, version: string,
 *   headers: Array<[string, string]>, map: object, body: 'none'|'length'|'chunked',
 *   contentLength: number, expectContinue: boolean, headLength: number
 * }}  map: lower-case name -> value (repeated fields joined with ", ")
 */
export function parseRequestHead (buf, start, end) {
  if (end - start > MAX_HEAD_BYTES) throw new HttpError(431, 'Richiesta troppo grande')
  const lines = b4a.toString(buf.subarray(start, end), 'latin1').split('\n')
  lines.pop() // after the final LF
  lines.pop() // the blank line
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]
    if (line.endsWith('\r')) line = line.slice(0, -1)
    if (line.includes('\r') || line.includes('\0')) throw new HttpError(400, BAD_REQUEST)
    lines[i] = line
  }
  if (lines.length === 0) throw new HttpError(400, BAD_REQUEST)

  const m = /^([^ ]+) ([^ ]+) ([^ ]+)$/.exec(lines[0])
  if (m === null) throw new HttpError(400, BAD_REQUEST)
  const [, method, target, version] = m
  if (!TOKEN_RE.test(method)) throw new HttpError(400, BAD_REQUEST)
  if (version !== 'HTTP/1.1' && version !== 'HTTP/1.0') {
    if (/^HTTP\/\d\.\d$/.test(version)) throw new HttpError(505, 'Versione HTTP non supportata')
    throw new HttpError(400, BAD_REQUEST)
  }
  if (!TARGET_RE.test(target)) throw new HttpError(400, BAD_REQUEST)

  if (lines.length - 1 > MAX_HEADERS) throw new HttpError(431, 'Richiesta troppo grande')
  const headers = []
  const map = Object.create(null)
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (line[0] === ' ' || line[0] === '\t') throw new HttpError(400, BAD_REQUEST) // obs-fold
    const colon = line.indexOf(':')
    if (colon <= 0) throw new HttpError(400, BAD_REQUEST)
    const name = line.slice(0, colon)
    if (!TOKEN_RE.test(name)) throw new HttpError(400, BAD_REQUEST) // also whitespace before ':'
    const value = line.slice(colon + 1).replace(/^[ \t]+|[ \t]+$/g, '')
    if (BAD_VALUE_RE.test(value)) throw new HttpError(400, BAD_REQUEST)
    headers.push([name, value])
    const lower = name.toLowerCase()
    if (lower in map) {
      if (lower === 'host') throw new HttpError(400, BAD_REQUEST)
      map[lower] += ', ' + value
    } else {
      map[lower] = value
    }
  }
  if (version === 'HTTP/1.1' && map.host === undefined) throw new HttpError(400, BAD_REQUEST)

  let body = 'none'
  let contentLength = 0
  const te = map['transfer-encoding']
  const cl = map['content-length']
  if (te !== undefined) {
    if (cl !== undefined || version === 'HTTP/1.0') throw new HttpError(400, BAD_REQUEST)
    if (te.toLowerCase() !== 'chunked') throw new HttpError(501, 'Codifica non supportata')
    body = 'chunked'
  } else if (cl !== undefined) {
    const parts = cl.split(',').map((p) => p.trim())
    if (!parts.every((p) => /^\d{1,15}$/.test(p)) || parts.some((p) => Number(p) !== Number(parts[0]))) {
      throw new HttpError(400, BAD_REQUEST)
    }
    contentLength = Number(parts[0])
    if (contentLength > 0) body = 'length'
  }

  const q = target.indexOf('?')
  return {
    method,
    target,
    path: q === -1 ? target : target.slice(0, q),
    query: q === -1 ? '' : target.slice(q),
    version,
    headers,
    map,
    body,
    contentLength,
    expectContinue: body !== 'none' && version === 'HTTP/1.1' && (map.expect || '').toLowerCase() === '100-continue',
    headLength: end
  }
}

/**
 * Incremental decoder of a chunked body (RFC 9112 7.1). push() returns the
 * number of bytes of `buf` it used once the body is complete (the rest is not
 * part of it), or -1 while more is needed. Throws HttpError 400 on bad framing,
 * 413 when the decoded body exceeds maxBytes. With collect: false it only finds
 * where the body ends (a forwarded body passes through untouched).
 */
export class ChunkedDecoder {
  constructor ({ maxBytes = Infinity, collect = true } = {}) {
    this.maxBytes = maxBytes
    this.size = 0 // decoded bytes so far
    this.done = false
    this._collect = collect
    this._parts = []
    this._state = 'size' // size, data, data-end, trailer
    this._line = '' // a size or trailer line being read
    this._left = 0 // bytes left in the current chunk
  }

  get body () {
    return b4a.concat(this._parts)
  }

  push (buf) {
    if (this.done) return 0
    let i = 0
    while (i < buf.byteLength) {
      if (this._state === 'data') {
        const n = Math.min(this._left, buf.byteLength - i)
        if (this._collect) this._parts.push(buf.subarray(i, i + n))
        this._left -= n
        i += n
        if (this._left === 0) this._state = 'data-end'
        continue
      }
      // Line states: size, data-end (the CRLF after the data), trailer.
      const byte = buf[i++]
      if (byte !== 10) {
        this._line += String.fromCharCode(byte)
        if (this._line.length > 4096) throw new HttpError(400, BAD_REQUEST)
        continue
      }
      let line = this._line
      this._line = ''
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (this._state === 'data-end') {
        if (line !== '') throw new HttpError(400, BAD_REQUEST)
        this._state = 'size'
      } else if (this._state === 'size') {
        const m = /^([0-9A-Fa-f]{1,12})[ \t]*(;.*)?$/.exec(line)
        if (m === null || /[\x00-\x08\x0a-\x1f\x7f]/.test(line)) throw new HttpError(400, BAD_REQUEST)
        const size = parseInt(m[1], 16)
        if (size === 0) {
          this._state = 'trailer'
        } else {
          if (this.size + size > this.maxBytes) throw new HttpError(413, 'Richiesta troppo grande')
          this.size += size
          this._left = size
          this._state = 'data'
        }
      } else if (line === '') { // trailer section ends with an empty line
        this.done = true
        return i
      } else if (line[0] === ' ' || line[0] === '\t' || line.indexOf(':') <= 0) {
        throw new HttpError(400, BAD_REQUEST)
      }
    }
    return -1
  }
}

// Hop-by-hop fields, the page's own (Origin, Referer, Cookie, the token) and the
// profile headers, which only the core sets; Host and Connection are rewritten.
const DROP_FORWARD = new Set([
  'host', 'connection', 'keep-alive', 'proxy-connection', 'upgrade', 'te', 'origin', 'referer', 'cookie', 'x-mpfy-token',
  'x-mpfy-profile', 'x-mpfy-profile-proof'
])
// Never dropped because the client named them in Connection: the body's framing.
const KEEP_ALWAYS = new Set(['content-length', 'transfer-encoding'])

/**
 * The head forwarded to a source: the same method, version, fields and framing,
 * the target without the /s/<id> prefix, `Host: 127.0.0.1:8091`, `Connection:
 * close`, no Origin, Referer, Cookie, X-MPfy-Token, profile header or hop-by-hop
 * field, and then the core's own fields.
 * @param {object} req  from parseRequestHead
 * @param {string} target  the rewritten target (starts with '/')
 * @param {object|null} [extra]  { Name: value } added by the core (the profile headers)
 * @returns {Uint8Array}
 */
export function buildForwardHead (req, target, extra = null) {
  const named = new Set()
  if (req.map.connection !== undefined) {
    for (const token of req.map.connection.split(',')) {
      const t = token.trim().toLowerCase()
      if (t !== '' && !KEEP_ALWAYS.has(t)) named.add(t)
    }
  }
  let head = req.method + ' ' + target + ' ' + req.version + '\r\nHost: ' + SOURCE_HOST + '\r\n'
  for (const [name, value] of req.headers) {
    const lower = name.toLowerCase()
    if (DROP_FORWARD.has(lower) || named.has(lower)) continue
    head += name + ': ' + value + '\r\n'
  }
  if (extra !== null) for (const name of Object.keys(extra)) head += name + ': ' + extra[name] + '\r\n'
  head += 'Connection: close\r\n\r\n'
  return b4a.from(head, 'latin1')
}

/**
 * Split /s/<id>/<rest> into the source id and the target to forward ('/<rest>'
 * plus the query). null when the path is not under /s/.
 */
export function splitSourceTarget (req) {
  if (!req.path.startsWith('/s/')) return null
  const after = req.path.slice(3)
  const slash = after.indexOf('/')
  const id = slash === -1 ? after : after.slice(0, slash)
  const rest = slash === -1 ? '/' : after.slice(slash)
  return { id, target: rest + req.query }
}

/** The head of a response written by the core. headers: { Name: value }. */
export function responseHead (status, headers) {
  let head = 'HTTP/1.1 ' + status + ' ' + (STATUS_TEXT[status] || 'Unknown') + '\r\n'
  for (const name of Object.keys(headers)) {
    const value = headers[name]
    if (value === undefined || value === null) continue
    head += name + ': ' + value + '\r\n'
  }
  return b4a.from(head + '\r\n', 'latin1')
}

/** If-None-Match against an ETag (weak comparison, RFC 9110 13.1.2). */
export function etagMatches (header, etag) {
  if (typeof header !== 'string' || header === '') return false
  if (header.trim() === '*') return true
  const opaque = (t) => t.trim().replace(/^W\//, '')
  const want = opaque(etag)
  return header.split(',').some((t) => opaque(t) === want)
}
