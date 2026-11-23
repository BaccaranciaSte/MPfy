/* global Bare */
// Bare worklet of the MPfy Android app. It runs the client core (client-core/index.js),
// which serves http://127.0.0.1:47123 for the WebView, the player and the downloads, and it talks
// to Kotlin (CoreHost.kt) over Bare.IPC with newline-delimited JSON, { t: '<type>', ... }:
//
//   Kotlin -> worklet
//     { t: 'start', statePath, webRoot, port, deviceName, token, phoneDir?, artDir?, appVersion? }
//       create and start the core.
//       token: a random secret for the life of the app's process. Every app on the phone can
//       reach 127.0.0.1, so the core must answer only requests that carry it: the WebView sends
//       it as the cookie mpfy_token, the player, the downloads and the notification artwork as
//       the header X-MPfy-Token (CoreHost.kt). Checking it, and keeping both out of what is
//       forwarded to a source, is the core's side (createClientCore option `token`).
//       phoneDir: where the phone's own music ("Locale", client-core/phone.js) keeps its files
//       (<statePath>.phone); artDir: the covers Kotlin made of the phone's files (read only).
//       Without phoneDir the core has no phone music.
//     { t: 'network' }                                         the default network changed
//     { t: 'local', op, ... }                                  the phone's music: access, progress,
//                                                              put, drop, reset, end (phone.js)
//     { t: 'net-reply', id, status, retryAfter, json | cover | error }   a lookup's answer
//     { t: 'stop' }                                            stop the core, then end the IPC
//   worklet -> Kotlin
//     { t: 'started', port } | { t: 'start-failed', code, message }
//     { t: 'local-hello', token, batch }   where the core's feed stands (once, after 'started')
//     { t: 'local-ack', token, batch }     that batch is in Locale's log, synced
//     { t: 'net', id, service, url, kind } an HTTPS GET for a lookup of the phone's music
//     { t: 'event', event }        the core's onEvent: { type: 'sources', sources, home }, { type: 'profile', profile }
//     { t: 'identity', fileName, text }   the core's identity event as the .mpfy file holds it (UTF-8
//                                  JSON, two spaces, final newline): Kotlin writes it to Documents/MPfy
//     { t: 'log', line }           the core's log
//     { t: 'suspended' } | { t: 'resumed' } | { t: 'stopped' }
//     { t: 'fatal', message }      an uncaught error; the worklet exits with code 1 right after
//
// Suspension (Bare Kit suspend/resume, driven by Kotlin when the app has been in the background
// for a while with nothing playing): the DHT node is suspended so the loop can go idle; the local
// server stays bound, so a connection made meanwhile waits in the backlog until the resume, which
// resumes the DHT and has every link re-check itself.
//
// Only relative imports: a bare specifier would resolve from android/worklet/node_modules first,
// which holds the build tools, not the core's dependencies.

import { createClientCore } from '../../client-core/index.js'
import { createDht } from '../../transport/client.js'

const ipc = Bare.IPC
let core = null
let dht = null
let lifecycle = Promise.resolve() // suspend and resume of the DHT, in order
let partial = [] // the pieces of an incomplete line

function send (msg) {
  try {
    ipc.write(Buffer.from(JSON.stringify(msg) + '\n'))
  } catch {}
}

// An uncaught error in a worklet aborts the whole process, the app included: report it, then
// exit only the worklet (Kotlin starts a new one).
function fatal (err) {
  send({ t: 'fatal', message: String((err && err.stack) || err) })
  Bare.exit(1)
}
Bare.on('uncaughtException', fatal)
Bare.on('unhandledRejection', fatal)

ipc.on('data', (chunk) => {
  // Split on '\n' at byte level, so a UTF-8 character cut between chunks stays whole. A long
  // line is joined once, when its end comes, never again at every chunk.
  let buf = chunk
  let nl
  while ((nl = buf.indexOf(10)) !== -1) {
    const head = buf.subarray(0, nl)
    const bytes = partial.length === 0 ? head : Buffer.concat([...partial, head])
    partial = []
    buf = buf.subarray(nl + 1)
    if (bytes.length === 0) continue
    let msg
    try {
      msg = JSON.parse(bytes.toString('utf8'))
    } catch {
      continue
    }
    handle(msg).catch(fatal)
  }
  if (buf.length > 0) partial.push(buf)
})

async function handle (msg) {
  switch (msg.t) {
    case 'start':
      return start(msg)
    case 'network':
      if (core !== null) core.refresh()
      return
    case 'local':
    case 'net-reply':
      // Never awaited here: the core applies the phone's messages one at a time, in arrival order.
      if (core !== null) core.phoneMessage(msg)
      return
    case 'stop':
      await stop()
      send({ t: 'stopped' })
      ipc.end()
  }
}

async function start (msg) {
  if (core !== null) return send({ t: 'started', port: core.state().port })
  dht = createDht()
  const c = createClientCore({
    statePath: msg.statePath,
    webRoot: msg.webRoot,
    port: msg.port,
    deviceName: msg.deviceName,
    token: typeof msg.token === 'string' && msg.token !== '' ? msg.token : undefined,
    phone: typeof msg.phoneDir === 'string' && msg.phoneDir !== ''
      ? { dir: msg.phoneDir, artDir: typeof msg.artDir === 'string' ? msg.artDir : null, appVersion: typeof msg.appVersion === 'string' ? msg.appVersion : null, send }
      : null,
    dht,
    log: (line) => send({ t: 'log', line: String(line) }),
    onEvent
  })
  try {
    const addr = await c.start()
    core = c
    send({ t: 'started', port: addr.port })
  } catch (err) {
    send({ t: 'start-failed', code: (err && err.code) || null, message: String((err && err.message) || err) })
    const d = dht
    dht = null
    await d.destroy().catch(() => {})
  }
}

function onEvent (event) {
  if (event && event.type === 'identity') {
    // The file's exact bytes are made here, so Kotlin never re-serializes the secret.
    send({ t: 'identity', fileName: String(event.fileName || ''), text: JSON.stringify(event.identity, null, 2) + '\n' })
    return
  }
  send({ t: 'event', event })
}

async function stop () {
  const c = core
  core = null
  if (c !== null) await c.stop()
  if (dht !== null) {
    const d = dht
    dht = null
    await d.destroy().catch(() => {})
  }
}

Bare.on('suspend', () => {
  lifecycle = lifecycle.then(async () => {
    if (dht !== null) await dht.suspend().catch(() => {})
    send({ t: 'suspended' })
  })
})

Bare.on('resume', () => {
  lifecycle = lifecycle.then(async () => {
    if (dht !== null) await dht.resume().catch(() => {})
    if (core !== null) core.refresh()
    send({ t: 'resumed' })
  })
})
