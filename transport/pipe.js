// One local TCP connection carried by one protomux channel, with flow control in
// both directions. Shared by the server (Node) and the client (Node or Bare), so it
// only touches the socket through the API that Node's net and bare-tcp have in
// common: write/end/destroy/pause/resume and the data/drain/end/close events.
//
// Flow control:
// - socket -> channel: every chunk read from the socket is sent as a data message.
//   Reading stops (socket.pause) while the mux stream is backed up (send returned
//   false; resumed by the channel's ondrain) or while the remote has not granted
//   enough credit.
// - channel -> socket: the receiver writes data into its socket and grants credit
//   back only once the socket accepted it (write returned true, or after 'drain').
//   A sender never has more than about WINDOW bytes un-credited per channel, so a
//   slow local reader (a paused player, a browser tab in the background) slows
//   the far end down instead of filling memory. Without this, protomux would keep
//   delivering and the receiving socket would buffer without limit.

import c from 'compact-encoding'

export const PROTOCOL = 'mpfy/tcp/1'

// Bytes a sender may have in flight per channel. 1 MB keeps a 100-300 ms mobile
// link busy (about 3-10 MB/s per channel) while bounding memory per connection.
export const WINDOW = 1024 * 1024

// The receiver returns credit in batches of at least this many bytes (fewer
// messages), or everything it has as soon as its socket drains. Must stay below
// WINDOW, otherwise a sender could stall forever with credit still owed.
export const CREDIT_BATCH = 64 * 1024

// How far past the window a sender may go: it checks the window after sending a
// whole socket read (64 KB on Node and bare-tcp), so a little slack, generously.
export const OVERSHOOT_LIMIT = 1024 * 1024

// Largest piece of data sent as one message: one socket read on Node and bare-tcp.
export const MAX_PIECE = 64 * 1024

// The end message carries the number 0 (c.uint), as it always did on the wire.
export const END_PAYLOAD = c.encode(c.uint, 0)

// A c.uint from a raw message payload. Throws on a truncated or empty payload;
// the callers run inside guard(), so that closes only the channel concerned.
export function decodeUint (buf) {
  return c.uint.decode({ start: 0, end: buf.byteLength, buffer: buf })
}

/**
 * Create a channel on `mux` for `socket` and pipe them together.
 * The caller passes a socket that is not being read yet (paused or just created);
 * this function starts reading it when the flow control allows.
 *
 * @param {object} mux       a Protomux instance
 * @param {object} socket    a TCP socket (net.Socket or bare-tcp Socket)
 * @param {object} opts
 * @param {Uint8Array} opts.id   channel id (4 random bytes, chosen by the client)
 * @param {Function} [opts.onclose]  called once when the channel is closed
 * @param {object} [opts.stats]  optional counters, see newPipeStats()
 * @param {Uint8Array} [opts.head]  bytes to send first, as if the socket had sent
 *   them (what a caller already read from the socket, e.g. a rewritten HTTP head)
 * @param {(n: number) => void} [opts.ondata]  called with the size of every chunk
 *   received from the remote and written to the socket (throughput measurement)
 * @returns the protomux channel, or null when the channel could not be created
 *          (the socket is left untouched in that case)
 */
export function pipeSocket (mux, socket, { id, onclose = null, stats = null, head = null, ondata = null } = {}) {
  let sendWindow = WINDOW // bytes we may still send before waiting for credit
  let ungranted = 0 // bytes received and handed to the socket, credit not yet returned
  let waitingSocketDrain = false
  let pausedForCredit = false
  let pausedForMux = false
  let socketPaused = true // the caller gives us a socket that is not flowing yet
  let sentEnd = false
  let gotEnd = false
  let socketClosed = false
  let channelClosed = false

  // All three messages are declared c.raw and the two numeric ones are decoded
  // here, inside guard(): protomux decodes a message BEFORE calling its handler,
  // outside any try of ours, and a decode error there (a truncated number from a
  // peer that does not follow the protocol) destroys the whole mux. c.raw never
  // throws. The bytes on the wire are the same as with c.uint.
  const channel = mux.createChannel({
    protocol: PROTOCOL,
    id,
    messages: [
      { encoding: c.raw, onmessage: guard(onremotedata) },
      { encoding: c.raw, onmessage: guard((buf) => onremotecredit(decodeUint(buf))) },
      { encoding: c.raw, onmessage: guard((buf) => onremoteend(decodeUint(buf))) }
    ],
    onclose: onchannelclose,
    ondrain: onmuxdrain
  })
  if (channel === null) return null

  const dataMessage = channel.messages[0]
  const creditMessage = channel.messages[1]
  const endMessage = channel.messages[2]

  if (stats) stats.opened++

  socket.on('data', onsocketdata)
  socket.on('drain', onsocketdrain)
  socket.on('end', onsocketend)
  socket.on('error', onsocketerror)
  socket.on('close', onsocketclose)

  channel.open()
  // Bytes the caller already took from the socket go first, counted against the
  // window like any socket read, in pieces no bigger than one socket read.
  if (head !== null && head.byteLength > 0) {
    for (let at = 0; at < head.byteLength && !channelClosed; at += MAX_PIECE) {
      onsocketdata(head.subarray(at, at + MAX_PIECE))
    }
  }
  updateSocketFlow()

  return channel

  // A throw inside a protomux message handler would destroy the whole mux (every
  // other channel of the connection with it). Contain it to this channel.
  function guard (fn) {
    return function (message) {
      try {
        fn(message)
      } catch (err) {
        fail(err)
      }
    }
  }

  function fail () {
    if (stats) stats.errors++
    if (!socketClosed) socket.destroy()
    if (!channelClosed) channel.close()
  }

  function onremotedata (buf) {
    // Data after the remote's end, or for a socket that is gone: drop it.
    if (gotEnd || socketClosed) return
    ungranted += buf.byteLength
    // A sender respecting the window never has more than WINDOW plus one read chunk
    // un-credited; a peer that keeps sending regardless would only fill our memory.
    if (ungranted > WINDOW + OVERSHOOT_LIMIT) throw new Error('flow control violated')
    if (stats) stats.bytesIn += buf.byteLength
    if (ondata !== null) ondata(buf.byteLength)
    const ok = socket.write(buf)
    if (stats && typeof socket.writableLength === 'number' && socket.writableLength > stats.maxQueued) {
      stats.maxQueued = socket.writableLength
    }
    if (ok) maybeGrant(false)
    else waitingSocketDrain = true
  }

  function onsocketdrain () {
    waitingSocketDrain = false
    maybeGrant(true)
  }

  function maybeGrant (all) {
    if (waitingSocketDrain || channelClosed || ungranted === 0) return
    if (!all && ungranted < CREDIT_BATCH) return
    const n = ungranted
    ungranted = 0
    creditMessage.send(c.encode(c.uint, n))
  }

  function onremotecredit (n) {
    sendWindow += n
    if (pausedForCredit && sendWindow > 0) {
      pausedForCredit = false
      updateSocketFlow()
    }
  }

  function onremoteend () {
    if (gotEnd) return
    gotEnd = true
    if (!socketClosed) socket.end()
  }

  function onsocketdata (chunk) {
    if (channelClosed) return
    sendWindow -= chunk.byteLength
    if (stats) stats.bytesOut += chunk.byteLength
    // send() returns false when the mux stream is backed up; its ondrain resumes us.
    if (!dataMessage.send(chunk)) pausedForMux = true
    if (sendWindow <= 0 && !pausedForCredit) {
      pausedForCredit = true
      if (stats) stats.creditStalls++
    }
    updateSocketFlow()
  }

  function onmuxdrain () {
    if (!pausedForMux) return
    pausedForMux = false
    updateSocketFlow()
  }

  function updateSocketFlow () {
    if (socketClosed) return
    const pause = pausedForCredit || pausedForMux
    if (pause && !socketPaused) {
      socketPaused = true
      socket.pause()
    } else if (!pause && socketPaused) {
      socketPaused = false
      socket.resume()
    }
  }

  function onsocketend () {
    // The local side finished sending (FIN): tell the remote, which ends its socket.
    if (sentEnd || channelClosed) return
    sentEnd = true
    endMessage.send(END_PAYLOAD)
  }

  function onsocketerror () {
    // 'close' always follows an error; the cleanup happens there.
    if (stats) stats.errors++
  }

  function onsocketclose () {
    socketClosed = true
    if (!channelClosed) channel.close()
  }

  function onchannelclose () {
    channelClosed = true
    // A clean close (both sides sent their end) lets the socket flush what it still
    // has buffered; anything else (remote error, link lost) aborts the connection so
    // the local peer sees a reset instead of a truncated but "complete" response.
    if (!socketClosed && !(sentEnd && gotEnd)) socket.destroy()
    if (stats) stats.closed++
    if (onclose) onclose()
  }
}

export function newPipeStats () {
  // maxQueued: the most bytes ever waiting in a local socket's write buffer (the
  // flow control keeps it near WINDOW); creditStalls: times a sender had to wait.
  return { opened: 0, closed: 0, errors: 0, bytesIn: 0, bytesOut: 0, maxQueued: 0, creditStalls: 0 }
}
