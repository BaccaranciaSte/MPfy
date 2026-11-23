// One forwarded request (/s/<id>/<rest>): the local TCP socket on one side, a raw
// byte stream to the source's HTTP port on the other (MPfyLink.openStream, one
// protomux channel with its own flow control).
//
// - Request: the rewritten head, then exactly the request's body as framed by its
//   head (Content-Length bytes, or a chunked body up to its last chunk and
//   trailers), passed through untouched. Whatever the client sends after that is
//   dropped: one request per local connection (the source sees Connection: close).
// - Response: piped back raw, the local connection ended when the source ends.
// - Backpressure both ways: the local socket stops being read while the channel is
//   backed up (its write side waits for credit), and the channel stops being read
//   (no credit goes back to the source) while the local socket's write buffer is
//   full, so a 600 MB upload or a paused player never piles up in memory.
// - Throughput (meter.js): a metered response reports every chunk to its flow,
//   and when it is held back by the local reader and let go again, so the meter
//   counts only what the link delivered at the link's own pace.
// - Teardown: a local connection that closes destroys the channel; a channel that
//   closes before a complete response resets the local connection (a truncated
//   answer must not look complete). Nothing outlives both.
//
// Portable: the socket API common to net and bare-tcp, streamx on the other side.

import { ChunkedDecoder } from './http.js'

// After the response is flushed, the client has this long to close its side.
const LINGER_MS = 5000
const noop = () => {}

/**
 * @param {object} opts
 * @param {object} opts.socket  the local socket (paused, no 'data' listener)
 * @param {object} opts.stream  streamx Duplex from link.openStream()
 * @param {Uint8Array} opts.head  the rewritten request head
 * @param {Uint8Array} opts.rest  bytes already read after the head
 * @param {object} opts.req  the parsed head (its body framing)
 * @param {object} [opts.flow]  a throughput flow (ThroughputMeter.flow()) when the
 *   response is metered: data(n), pause(), resume(), end()
 */
export function pipeForward ({ socket, stream, head, rest, req, flow = null }) {
  let bodyLeft = req.body === 'length' ? req.contentLength : 0
  const scanner = req.body === 'chunked' ? new ChunkedDecoder({ collect: false }) : null
  let bodyDone = req.body === 'none'
  let waitingDrain = false
  let streamPaused = false // the response held back because the local socket is full
  let responseEnded = false
  let socketClosed = false
  let lingerTimer = null

  socket.on('data', onsocketdata)
  socket.on('end', onsocketend)
  socket.on('drain', onsocketdrain)
  socket.on('close', onsocketclose)
  stream.on('data', onstreamdata)
  stream.on('drain', onstreamdrain)
  stream.on('end', onstreamend)
  stream.on('error', noop) // 'close' follows; handled there
  stream.on('close', onstreamclose)

  if (stream.write(head) === false) waitingDrain = true
  if (rest.byteLength > 0 && !bodyDone) sendBody(rest)
  if (!waitingDrain) socket.resume()

  function sendBody (chunk) {
    let piece = chunk
    if (scanner !== null) {
      let used
      try {
        used = scanner.push(chunk)
      } catch {
        abort() // a chunked body the source could not read either
        return
      }
      if (used !== -1) {
        piece = chunk.subarray(0, used)
        bodyDone = true
      }
    } else if (chunk.byteLength >= bodyLeft) {
      piece = chunk.subarray(0, bodyLeft)
      bodyLeft = 0
      bodyDone = true
    } else {
      bodyLeft -= chunk.byteLength
    }
    if (piece.byteLength > 0 && !stream.destroyed && stream.write(piece) === false) {
      waitingDrain = true
      socket.pause()
    }
  }

  function onsocketdata (chunk) {
    if (bodyDone) return // after the request: dropped
    sendBody(chunk)
  }

  function onstreamdrain () {
    waitingDrain = false
    if (!socketClosed) socket.resume()
  }

  function onsocketend () {
    // The client stopped sending before its body was complete: no answer can come.
    if (!bodyDone) abort()
  }

  function onstreamdata (chunk) {
    if (flow !== null) flow.data(chunk.byteLength)
    if (socketClosed) return
    if (socket.write(chunk) === false) {
      streamPaused = true
      stream.pause()
      if (flow !== null) flow.pause()
    }
  }

  function onsocketdrain () {
    if (!streamPaused) return
    streamPaused = false
    stream.resume()
    // After stream.resume(): what the stream buffered meanwhile comes out first,
    // at memory speed, and the flow skips it (meter.js).
    if (flow !== null) flow.resume()
  }

  function onstreamend () {
    // The source answered and closed (Connection: close). End our half of the
    // channel too, so it closes cleanly, and the local connection once flushed.
    responseEnded = true
    bodyDone = true // an early answer (a refused upload): the rest of the body is not wanted
    if (flow !== null) flow.end()
    stream.end()
    if (socketClosed) return
    socket.end()
    socket.once('finish', () => {
      lingerTimer = setTimeout(() => socket.destroy(), LINGER_MS)
    })
  }

  function onstreamclose () {
    if (flow !== null) flow.end()
    if (!responseEnded && !socketClosed) socket.destroy()
  }

  function onsocketclose () {
    socketClosed = true
    if (flow !== null) flow.end()
    clearTimeout(lingerTimer)
    if (!responseEnded && !stream.destroyed) stream.destroy()
  }

  function abort () {
    socket.destroy()
    if (!stream.destroyed) stream.destroy()
  }
}
