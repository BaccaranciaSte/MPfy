// One protomux channel of the TCP protocol (pipe.js) exposed as a streamx Duplex,
// for requests the client core makes on its own (no local socket involved), e.g.
// DELETE /api/admin/clients/self. Same wire protocol and the same flow control as
// pipeSocket(): the remote end is a TCP connection to the source's HTTP port.
//
// - write side: data is cut into pieces of at most MAX_PIECE bytes and sent while
//   the remote has granted credit; the write callback waits for credit (and for
//   the mux stream to drain), so a writer cannot run ahead of the window.
// - read side: data from the remote is pushed into the readable buffer; credit
//   goes back only when streamx asks for more (_read), so a consumer that does not
//   read holds the remote back.
// - the receive window: the remote starts with WINDOW bytes of credit (the wire
//   protocol), but a stream offers only `window` (windowFor(rtt): what keeps one
//   stream at STREAM_RATE over the link's round trip). It gives back the credit of
//   what its reader took less the difference, so once the reader has taken that
//   much, the remote never has more than `window` bytes sent and not yet taken: a
//   player whose buffer is full holds about one window here, not the transport's
//   whole window, and a skip throws that much away at most. The remote needs no
//   change: it only ever sees less credit.
//
// Portable: streamx, compact-encoding (Node and Bare).

import { Duplex } from 'streamx'
import c from 'compact-encoding'
import { PROTOCOL, WINDOW, OVERSHOOT_LIMIT, MAX_PIECE, END_PAYLOAD, decodeUint } from './pipe.js'

// The smallest receive window of a stream, and the rate one stream should reach
// whatever the link's round trip (64 Mbit/s: far above any audio level).
export const STREAM_WINDOW_MIN = 128 * 1024
export const STREAM_RATE = 8 * 1024 * 1024

/** The receive window of a stream on a link with this round trip (ms; unknown: WINDOW). */
export function windowFor (rttMs) {
  if (!(typeof rttMs === 'number' && rttMs > 0)) return WINDOW
  return Math.min(WINDOW, Math.max(STREAM_WINDOW_MIN, Math.ceil((STREAM_RATE * rttMs) / 1000)))
}

/**
 * @param {object} mux  a Protomux instance
 * @param {object} opts
 * @param {Uint8Array} opts.id  channel id (4 random bytes)
 * @param {object} [opts.stats]  counters, see newPipeStats()
 * @param {number} [opts.window]  the receive window this stream offers (at most WINDOW)
 * @returns {Duplex|null} null when the channel could not be created
 */
export function channelStream (mux, { id, stats = null, window = WINDOW } = {}) {
  let sendWindow = WINDOW
  // What the remote sent, and the credit given back beyond the WINDOW it starts with.
  let received = 0
  let credited = 0
  // Credit withheld for good: the remote is never more than the window ahead.
  const debt = WINDOW - Math.min(WINDOW, Math.max(MAX_PIECE, window))
  let muxBackedUp = false
  let gotEnd = false
  let sentEnd = false
  let channelClosed = false
  let queue = [] // pieces waiting for credit
  let writeCallback = null // the pending _write callback, called when the queue empties
  let stream = null

  const channel = mux.createChannel({
    protocol: PROTOCOL,
    id,
    messages: [
      { encoding: c.raw, onmessage: guard(onremotedata) },
      { encoding: c.raw, onmessage: guard((buf) => onremotecredit(decodeUint(buf))) },
      { encoding: c.raw, onmessage: guard(() => onremoteend()) }
    ],
    onclose: onchannelclose,
    ondrain: onmuxdrain
  })
  if (channel === null) return null

  const dataMessage = channel.messages[0]
  const creditMessage = channel.messages[1]
  const endMessage = channel.messages[2]
  if (stats) stats.opened++

  stream = new Duplex({
    write (data, cb) {
      if (channelClosed || sentEnd) {
        cb(new Error('CHANNEL_CLOSED'))
        return
      }
      for (let at = 0; at < data.byteLength; at += MAX_PIECE) queue.push(data.subarray(at, at + MAX_PIECE))
      writeCallback = cb
      flush()
    },
    final (cb) {
      if (!sentEnd && !channelClosed) {
        sentEnd = true
        endMessage.send(END_PAYLOAD)
      }
      cb(null)
    },
    read (cb) {
      // The consumer wants more: give the remote back the credit for what it read.
      grant()
      cb(null)
    },
    predestroy () {
      if (!channelClosed) channel.close()
    },
    destroy (cb) {
      if (!channelClosed) channel.close()
      cb(null)
    }
  })

  channel.open()
  return stream

  // A throw inside a protomux message handler would destroy the whole mux.
  function guard (fn) {
    return function (message) {
      try {
        fn(message)
      } catch (err) {
        if (stats) stats.errors++
        stream.destroy(err)
      }
    }
  }

  function flush () {
    while (queue.length > 0 && sendWindow > 0 && !muxBackedUp && !channelClosed) {
      const piece = queue.shift()
      sendWindow -= piece.byteLength
      if (stats) stats.bytesOut += piece.byteLength
      if (!dataMessage.send(piece)) muxBackedUp = true
    }
    if (queue.length > 0 && sendWindow <= 0 && stats) stats.creditStalls++
    if (queue.length === 0 && writeCallback !== null) {
      const cb = writeCallback
      writeCallback = null
      cb(null)
    }
  }

  function onremotedata (buf) {
    if (gotEnd) return
    received += buf.byteLength
    if (received - credited > WINDOW + OVERSHOOT_LIMIT) throw new Error('flow control violated')
    if (stats) stats.bytesIn += buf.byteLength
    stream.push(buf)
  }

  // The credit of what the reader took (all that was received but what waits in
  // the buffer), less the debt.
  function grant () {
    if (channelClosed) return
    const target = received - stream._readableState.buffered - debt
    if (target <= credited) return
    const n = target - credited
    credited = target
    creditMessage.send(c.encode(c.uint, n))
  }

  function onremotecredit (n) {
    sendWindow += n
    flush()
  }

  function onmuxdrain () {
    if (!muxBackedUp) return
    muxBackedUp = false
    flush()
  }

  function onremoteend () {
    if (gotEnd) return
    gotEnd = true
    stream.push(null)
  }

  function onchannelclose () {
    channelClosed = true
    if (stats) stats.closed++
    queue = []
    if (writeCallback !== null) {
      const cb = writeCallback
      writeCallback = null
      cb(new Error('CHANNEL_CLOSED'))
    }
    // A clean close (the remote sent all of its data and its end) leaves what is
    // buffered for the reader; anything else is an error.
    if (!gotEnd) stream.destroy(new Error('CHANNEL_CLOSED'))
  }
}
