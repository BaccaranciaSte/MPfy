// A fake LRCLIB for the tests, on 127.0.0.1: GET /api/get answered from
// `answers` by its track_name (else 404), every request recorded as { path,
// query (URLSearchParams), headers, at }.
//   answers.set('<track_name>', { status: 200, body: {...}, headers: {...} })
//   answers.set('<track_name>', (query) => ({ status, body, headers }))
//   first.push({ status: 429, headers: { 'retry-after': '1' } })   answered first, in turn
//   first.push('drop')                                             the connection cut, no answer

import http from 'node:http'
import { listenServer, closeServer } from './helpers.mjs'

export async function fakeLrclib () {
  const requests = []
  const answers = new Map()
  const first = []
  const send = (res, { status = 200, body = null, headers = {} }) => {
    const buf = Buffer.from(body === null ? '' : typeof body === 'string' ? body : JSON.stringify(body))
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': buf.length, ...headers })
    res.end(buf)
  }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    requests.push({ method: req.method, path: url.pathname, query: url.searchParams, raw: req.url, headers: req.headers, at: Date.now() })
    req.resume()
    if (first.length > 0) {
      const next = first.shift()
      if (next === 'drop') return req.socket.destroy()
      return send(res, next)
    }
    if (req.method !== 'GET' || url.pathname !== '/api/get') return send(res, { status: 404, body: { code: 404, name: 'NotFound' } })
    const a = answers.get(url.searchParams.get('track_name'))
    if (a === undefined) return send(res, { status: 404, body: { code: 404, name: 'TrackNotFound', message: 'Failed to find specified track' } })
    send(res, typeof a === 'function' ? a(url.searchParams) : a)
  })
  const port = await listenServer(server)
  return {
    url: 'http://127.0.0.1:' + port,
    port,
    requests,
    answers,
    first,
    /** The requests of one track. */
    of (title) {
      return requests.filter((r) => r.query.get('track_name') === title)
    },
    async close () {
      server.closeAllConnections()
      await closeServer(server)
    }
  }
}

/** A 200 of LRCLIB with these fields (the rest as the real one gives them). */
export function found ({ synced = null, plain = null, instrumental = false, title = 'Brano', artist = 'Lumen Marino', album = 'Ultimo traghetto', duration = 180 } = {}) {
  return { status: 200, body: { id: 1, trackName: title, artistName: artist, albumName: album, duration, instrumental, plainLyrics: plain, syncedLyrics: synced } }
}
