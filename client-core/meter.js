// Throughput of one source's link (bytes per second over the last 20 s of
// streaming, for the "Automatica" audio quality). What has to come out is the
// LINK's speed, so only the time during which the link is what limits the data
// counts:
//
// - Only streams are metered: the owner opens a flow for each forwarded
//   /api/stream/ response and for nothing else. Covers, the library and other
//   small answers are dominated by their round trip, not by the link's speed.
// - The first chunk of a flow only marks its start: the time it took to come
//   (the request's round trip) is not streaming time.
// - While the local reader holds a flow back (its socket is full: a player whose
//   buffer is full reads at playback pace), the flow is paused and nothing of it
//   counts. When it resumes, the bytes that waited in the local buffers come out
//   at memory speed: they are skipped, and the next chunk off the network only
//   marks a new start. Otherwise a player reading at 264 kbps would make the link
//   look like a 264 kbps link, and "Automatica" would only ever step down.
// - A silence longer than IDLE_GAP_MS between two counted chunks is a stall, not
//   streaming time, and is not counted either.
// - Flows of the same source share one timeline: busy time is counted once
//   however many flows are running, so the figure is the link's, not one
//   response's.
//
// The window is the most recent 20 s of busy time, from at most the last 10
// minutes; the owner resets it when the link drops or the network changes.
//
// Portable: timers and queueMicrotask only.

export const WINDOW_BUSY_MS = 20000
export const IDLE_GAP_MS = 1500
export const MAX_AGE_MS = 10 * 60 * 1000
const BUCKET_MS = 250
const MAX_BUCKETS = 400
// Too little data says nothing: report only after this much busy time, or this
// many bytes over at least MIN_BURST_MS.
const MIN_BUSY_MS = 1000
const MIN_BYTES = 256 * 1024
const MIN_BURST_MS = 100

const microtask = typeof queueMicrotask === 'function' ? queueMicrotask : (fn) => Promise.resolve().then(fn)

export class ThroughputMeter {
  constructor ({ now = Date.now } = {}) {
    this._now = now
    this._buckets = [] // { t, bytes, busy }, oldest first
    this._counting = 0 // flows whose chunks count right now
    this._mark = -1 // time up to which busy time is accounted; -1: none yet
  }

  /**
   * A new metered response (a stream). Call, on the returned flow: data(n) for
   * every chunk passed on, pause() when the local reader holds it back, resume()
   * right AFTER resuming the source stream, end() once it is over.
   */
  flow () {
    return new Flow(this)
  }

  reset () {
    this._buckets = []
    this._mark = -1 // the next chunk only marks a start
  }

  /** Kilobits per second, or null while there is not enough to say. */
  kbps () {
    const oldest = this._now() - MAX_AGE_MS
    while (this._buckets.length > 0 && this._buckets[0].t < oldest) this._buckets.shift()
    let bytes = 0
    let busy = 0
    for (let i = this._buckets.length - 1; i >= 0 && busy < WINDOW_BUSY_MS; i--) {
      bytes += this._buckets[i].bytes
      busy += this._buckets[i].busy
    }
    if (busy < MIN_BUSY_MS && !(bytes >= MIN_BYTES && busy >= MIN_BURST_MS)) return null
    // bytes per millisecond times 8 is kilobits per second
    return Math.max(1, Math.round((bytes * 8) / busy))
  }

  _start () {
    if (this._counting++ === 0) this._mark = this._now()
  }

  _stop () {
    if (--this._counting === 0) this._mark = -1
  }

  _count (n) {
    const t = this._now()
    const gap = this._mark === -1 ? Infinity : t - this._mark
    this._mark = t
    if (!(gap <= IDLE_GAP_MS)) return // a stall (or the first chunk after a reset)
    let b = this._buckets.length > 0 ? this._buckets[this._buckets.length - 1] : null
    if (b === null || t - b.t >= BUCKET_MS) {
      b = { t, bytes: 0, busy: 0 }
      this._buckets.push(b)
      if (this._buckets.length > MAX_BUCKETS) this._buckets.shift()
    }
    b.bytes += n
    b.busy += Math.max(0, gap)
  }
}

// A flow's states.
const WAITING = 0 // the next chunk only marks a start
const COUNTING = 1
const PAUSED = 2 // held back by the local reader
const SKIPPING = 3 // just resumed: what comes now was waiting in the local buffers
const ENDED = 4

class Flow {
  constructor (meter) {
    this._meter = meter
    this._state = WAITING
    this._resumes = 0
  }

  /** n bytes of the response were passed on. */
  data (n) {
    if (this._state === COUNTING) {
      this._meter._count(n)
    } else if (this._state === WAITING) {
      this._state = COUNTING
      this._meter._start()
    }
    // PAUSED, SKIPPING, ENDED: not the network's pace.
  }

  /** The local reader stopped taking data (its socket is full). */
  pause () {
    if (this._state === ENDED) return
    if (this._state === COUNTING) this._meter._stop()
    this._state = PAUSED
  }

  /**
   * The local reader takes data again. Call it right AFTER resuming the source
   * stream: a streamx stream hands out what it buffered in the microtask it
   * queued on resume(), which runs before the one queued here, so every buffered
   * chunk is seen while SKIPPING.
   */
  resume () {
    if (this._state !== PAUSED) return
    this._state = SKIPPING
    const resumes = ++this._resumes
    microtask(() => {
      if (this._state === SKIPPING && this._resumes === resumes) this._state = WAITING
    })
  }

  end () {
    if (this._state === COUNTING) this._meter._stop()
    this._state = ENDED
  }
}
