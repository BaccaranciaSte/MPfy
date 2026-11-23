// Fake AcoustID, MusicBrainz and Cover Art Archive servers for the tests, each on
// its own port with its own clock: every request is recorded as { service,
// method, path, headers, body, at }.
//
// `answers` (changed by the test at any time):
//   acoustid: { "<compressed fingerprint>": <JSON answer> }, else { status: ok, results: [] }
//   acoustidStatus: [503, 503, ...]  statuses to answer first, one per request
//   acoustidError: 4                 every answer is that error (HTTP 400)
//   mb: { "<path without /ws/2/, with its query>": <JSON> | <number status> }
//     the lookup of a recording or a release is found by "recording/<id>" or
//     "release/<id>" too (its query aside)
//   mbSearch: (query) => <JSON>       the recording text search
//   mbStatus: [...]                   statuses to answer first
//   caa: { "release/<id>" | "release-group/<id>": Buffer | <number status> }
//     an image is served through a 307 to /img/..., like the real one
//   drop: ['acoustid', ...]           those services close every connection unanswered (no network)
//   hold: { caa: <Promise> }          that service answers once the promise settles (recorded at once)

import http from 'node:http'
import { listenServer, closeServer } from './helpers.mjs'

export async function fakeServices () {
  const requests = []
  const answers = { acoustid: {}, acoustidStatus: [], acoustidError: null, mb: {}, mbSearch: null, mbStatus: [], caa: {}, drop: [], hold: {} }
  const servers = {}
  const urls = {}

  const send = (res, status, data, type = 'application/json') => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(typeof data === 'string' ? data : JSON.stringify(data))
    res.writeHead(status, { 'content-type': type, 'content-length': buf.length })
    res.end(buf)
  }

  const handlers = {
    acoustid (req, res, url, body) {
      if (answers.acoustidStatus.length > 0) return send(res, answers.acoustidStatus.shift(), { status: 'error', error: { code: 99, message: 'busy' } })
      if (answers.acoustidError !== null) return send(res, 400, { status: 'error', error: { code: answers.acoustidError, message: 'invalid API key' } })
      if (req.method !== 'POST' || url.pathname !== '/v2/lookup') return send(res, 404, { status: 'error' })
      const form = new URLSearchParams(body.toString('utf8'))
      const answer = answers.acoustid[form.get('fingerprint')]
      return send(res, 200, answer || { status: 'ok', results: [] })
    },
    musicbrainz (req, res, url) {
      if (answers.mbStatus.length > 0) return send(res, answers.mbStatus.shift(), { error: 'busy' })
      const rest = url.pathname.replace(/^\/ws\/2\//, '')
      if (rest === 'recording' && url.searchParams.has('query')) {
        return send(res, 200, answers.mbSearch ? answers.mbSearch(url.searchParams.get('query')) : { recordings: [] })
      }
      const answer = answers.mb[rest + url.search] !== undefined ? answers.mb[rest + url.search] : answers.mb[rest]
      if (answer === undefined) return send(res, 404, { error: 'Not Found' })
      if (typeof answer === 'number') return send(res, answer, { error: 'status ' + answer })
      return send(res, 200, answer)
    },
    caa (req, res, url) {
      if (url.pathname.startsWith('/img/')) {
        const answer = answers.caa[decodeURIComponent(url.pathname.slice(5))]
        return send(res, 200, answer, 'image/jpeg')
      }
      const m = /^\/(release|release-group)\/([^/]+)\/front-500$/.exec(url.pathname)
      const key = m ? m[1] + '/' + m[2] : null
      const answer = key === null ? undefined : answers.caa[key]
      if (answer === undefined) return send(res, 404, 'Not Found', 'text/plain')
      if (typeof answer === 'number') return send(res, answer, 'status', 'text/plain')
      res.writeHead(307, { location: '/img/' + encodeURIComponent(key) })
      res.end()
    }
  }

  for (const service of Object.keys(handlers)) {
    const server = http.createServer((req, res) => {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const body = Buffer.concat(chunks)
        const url = new URL(req.url, 'http://127.0.0.1')
        requests.push({ service, method: req.method, path: url.pathname, query: url.search, headers: req.headers, body: body.toString('utf8'), at: Date.now(), dropped: answers.drop.includes(service) })
        if (answers.drop.includes(service)) return req.socket.destroy()
        const answer = () => handlers[service](req, res, url, body)
        if (answers.hold[service]) return Promise.resolve(answers.hold[service]).then(answer, answer)
        answer()
      })
    })
    const port = await listenServer(server)
    servers[service] = server
    urls[service] = 'http://127.0.0.1:' + port
  }

  return {
    urls,
    answers,
    requests,
    /** The requests of one service (not the image hop of the CAA redirect unless asked). */
    of (service, { hops = false } = {}) {
      return requests.filter((r) => r.service === service && (hops || !r.path.startsWith('/img/')))
    },
    async close () {
      for (const server of Object.values(servers)) {
        server.closeAllConnections()
        await closeServer(server)
      }
    }
  }
}
