// Response and request helpers shared by the API and the admin server.

import { HttpError } from './errors.mjs'
import { logError } from './util.mjs'

const JSON_TYPE = 'application/json; charset=utf-8'
const MAX_JSON_BODY = 4 * 1024 * 1024

export function sendJson (req, res, status, obj, headers = {}) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8')
  res.statusCode = status
  res.setHeader('Content-Type', JSON_TYPE)
  res.setHeader('Content-Length', body.length)
  if (!res.hasHeader('Cache-Control')) res.setHeader('Cache-Control', 'no-store')
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v)
  res.end(req.method === 'HEAD' ? undefined : body)
}

export function sendError (req, res, err) {
  const status = err instanceof HttpError ? err.status : 500
  const message = err instanceof HttpError ? err.message : 'Errore interno del server'
  if (!(err instanceof HttpError)) logError('internal error on ' + req.method + ' ' + req.url + ': ' + (err && err.stack ? err.stack : err))
  if (res.headersSent) {
    res.destroy()
    return
  }
  // Headers set for a success response (types, cache, ranges) must not leak into the error.
  for (const name of res.getHeaderNames()) res.removeHeader(name)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  if (!req.complete) refuseRestOfBody(req, res)
  const body = err instanceof HttpError && err.extra ? { ...err.extra } : {}
  // A finished session's state keeps its own `error`: none when it worked.
  if (!(err instanceof HttpError && err.state === true && body.done === true)) body.error = message
  if (err instanceof HttpError && err.code) body.code = err.code
  sendJson(req, res, status, body)
}

/**
 * We answer before reading the whole body (413, or an error mid-upload): ask the
 * client to close, let it read the answer while we discard what still arrives for
 * a short while, then cut the connection.
 */
export function refuseRestOfBody (req, res) {
  res.setHeader('Connection', 'close')
  res.once('finish', () => {
    req.resume()
    const t = setTimeout(() => req.socket && req.socket.destroy(), 2000)
    t.unref()
  })
}

/** Read a whole (small) body as bytes; 413 above `limit`. */
export function readBody (req, limit) {
  return new Promise((resolve, reject) => {
    const declared = req.headers['content-length']
    if (declared !== undefined && Number(declared) > limit) {
      reject(new HttpError(413, 'Richiesta troppo grande'))
      return
    }
    const chunks = []
    let size = 0
    let done = false
    const finish = (err, value) => {
      if (done) return
      done = true
      req.off('data', ondata)
      req.off('end', onend)
      req.off('error', onerror)
      if (err) reject(err)
      else resolve(value)
    }
    const ondata = (chunk) => {
      size += chunk.length
      if (size > limit) {
        req.pause()
        finish(new HttpError(413, 'Richiesta troppo grande'))
        return
      }
      chunks.push(chunk)
    }
    const onend = () => finish(null, Buffer.concat(chunks))
    const onerror = () => finish(new HttpError(400, 'Richiesta interrotta'))
    req.on('data', ondata)
    req.on('end', onend)
    req.on('error', onerror)
  })
}

/** Read and parse a JSON body (any content type; the origin checks protect POSTs). */
export function readJson (req, limit = MAX_JSON_BODY) {
  return new Promise((resolve, reject) => {
    const declared = req.headers['content-length']
    if (declared !== undefined && Number(declared) > limit) {
      reject(new HttpError(413, 'Richiesta troppo grande'))
      return
    }
    const chunks = []
    let size = 0
    let done = false
    const finish = (err, value) => {
      if (done) return
      done = true
      req.off('data', ondata)
      req.off('end', onend)
      req.off('error', onerror)
      if (err) reject(err)
      else resolve(value)
    }
    const ondata = (chunk) => {
      size += chunk.length
      if (size > limit) {
        req.pause()
        finish(new HttpError(413, 'Richiesta troppo grande'))
        return
      }
      chunks.push(chunk)
    }
    const onend = () => {
      if (size === 0) return finish(null, {})
      try {
        finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        finish(new HttpError(400, 'JSON non valido'))
      }
    }
    const onerror = () => finish(new HttpError(400, 'Richiesta interrotta'))
    req.on('data', ondata)
    req.on('end', onend)
    req.on('error', onerror)
  })
}

/** A JSON body must be an object for our endpoints (413 above `limit`). */
export async function readJsonObject (req, limit = MAX_JSON_BODY) {
  const body = await readJson(req, limit)
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Corpo della richiesta non valido')
  return body
}

const LOCAL_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]'])

function hostName (value) {
  const v = String(value).trim().toLowerCase()
  if (v.startsWith('[')) return v.slice(0, v.indexOf(']') + 1)
  return v.split(':')[0]
}

/**
 * DNS rebinding guard: a page on some other site whose name resolves to 127.0.0.1
 * would send its own name as Host. Only local names (plus MPFY_ALLOWED_HOSTS)
 * are accepted. A request without Host (HTTP/1.0, curl -H 'Host:') is local.
 */
export function hostAllowed (req, extraHosts) {
  const host = req.headers.host
  if (host === undefined || host === '') return true
  const name = hostName(host)
  return LOCAL_NAMES.has(name) || extraHosts.has(name)
}

/**
 * CSRF guard for state-changing requests: browsers send Origin on cross-site
 * requests; it must be one of our local origins.
 */
export function originAllowed (req, extraHosts) {
  const origin = req.headers.origin
  if (origin === undefined) return true
  let url
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  const name = url.hostname.startsWith('[') ? url.hostname : hostName(url.hostname)
  return LOCAL_NAMES.has(name) || extraHosts.has(name)
}

export function parseExtraHosts (value) {
  const set = new Set()
  for (const part of String(value || '').split(',')) {
    const name = part.trim().toLowerCase()
    if (name) set.add(name)
  }
  return set
}

/** Split "/api/a/b%20c" (after the prefix) into decoded segments; throws 400 on bad escapes. */
export function segments (pathname, prefix) {
  const rest = pathname.slice(prefix.length)
  const parts = rest === '' ? [] : rest.split('/')
  return parts.map((p) => {
    try {
      return decodeURIComponent(p)
    } catch {
      throw new HttpError(400, 'Percorso non valido')
    }
  })
}
