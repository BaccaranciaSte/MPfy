// The control channel "mpfy/ctl/1": one per connection, next to the TCP channels.
// Today it only carries ping/pong, so the client can measure the round trip when
// the raw stream does not report one. Message 0 is a ping, message 1 its pong;
// the payload (at most 16 bytes) is echoed as is.
//
// Portable: compact-encoding only (Node and Bare).

import c from 'compact-encoding'

export const CONTROL_PROTOCOL = 'mpfy/ctl/1'
const MAX_PING_BYTES = 16

/** Server side: answer every ping. Returns the channel (or null). */
export function serveControl (mux) {
  let pong = null
  const channel = mux.createChannel({
    protocol: CONTROL_PROTOCOL,
    messages: [
      {
        encoding: c.raw,
        onmessage: (buf) => {
          if (pong !== null && buf.byteLength <= MAX_PING_BYTES) pong.send(buf)
        }
      },
      { encoding: c.raw }
    ]
  })
  if (channel === null) return null
  pong = channel.messages[1]
  channel.open()
  return channel
}

/**
 * Client side: a pinger on the control channel.
 * @param {object} mux
 * @param {(rttMs: number) => void} onrtt
 * @returns {{ ping(): boolean, close(): void, opened: boolean } | null}
 */
export function controlClient (mux, onrtt) {
  let seq = 0
  let sentSeq = -1
  let sentAt = 0
  let opened = false
  const channel = mux.createChannel({
    protocol: CONTROL_PROTOCOL,
    messages: [
      { encoding: c.raw },
      {
        encoding: c.raw,
        onmessage: (buf) => {
          let n
          try {
            n = c.uint.decode({ start: 0, end: buf.byteLength, buffer: buf })
          } catch {
            return
          }
          if (n !== sentSeq) return
          sentSeq = -1
          onrtt(Math.max(1, Date.now() - sentAt))
        }
      }
    ],
    onopen: () => { opened = true }
  })
  if (channel === null) return null
  const ping = channel.messages[0]
  channel.open()
  return {
    get opened () {
      return opened
    },
    ping () {
      if (channel.closed) return false
      seq = (seq + 1) % 0x40000000
      sentSeq = seq
      sentAt = Date.now()
      ping.send(c.encode(c.uint, seq))
      return true
    },
    close () {
      if (!channel.closed) channel.close()
    }
  }
}
